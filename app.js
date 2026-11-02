
(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const PROJECTS_KEY = "jarvis_projects_v1";
  const SETTINGS_KEY = "jarvis_settings_v1";

  const DEFAULT_SYSTEM = `
You are JARVIS, a calm, intelligent and capable personal AI assistant.
You speak naturally and concisely.
You help with technology, programming and everyday tasks.
You are running in a browser on a Meta Quest headset.
Never claim to control hardware or applications you cannot access.
Explain technical procedures clearly.
`;

  let apiKey = sessionStorage.getItem("jarvis_groq_key") || "";
  let history = [];
  let settings = loadJSON(SETTINGS_KEY, {
    model: "openai/gpt-oss-20b",
    language: "en-US",
    systemPrompt: DEFAULT_SYSTEM
  });

  let projects = loadJSON(PROJECTS_KEY, []);

  let activeProjectId = null;
  let busy = false;

  // VOICE STATE
  let recognition = null;
  let listening = false;
  let restartingRecognition = false;
  let lastAssistantSpeech = "";
  let requestQueue = [];
  let processingQueue = false;

  // --------------------------------------------------
  // STORAGE
  // --------------------------------------------------

  function loadJSON(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      console.error("Storage error:", error);
      alert("Local storage error: " + error.message);
      return false;
    }
  }

  // --------------------------------------------------
  // INTERFACE
  // --------------------------------------------------

  function setStatus(message, success = true) {
    $("connectionLabel").textContent = message;
    $("connectionLabel").style.color =
      success ? "var(--green)" : "#ff7777";
  }

  function setBusy(value) {
    busy = value;

    // The previous version referred to a nonexistent
    // sendButton ID. This version selects the real button.
    const sendButton = document.querySelector(
      "#chatForm button[type='submit']"
    );

    if (sendButton) {
      sendButton.disabled = value;
      sendButton.style.opacity = value ? ".5" : "1";
    }

    $("aiStatus").textContent = value
      ? "PROCESSING"
      : apiKey ? "READY" : "OFFLINE";
  }

  function addMessage(role, content, formatted = false) {
    const article = document.createElement("article");
    article.className = "message " + role;

    const tag = document.createElement("div");
    tag.className = "message-tag";
    tag.textContent = role === "assistant" ? "JARVIS" : "YOU";

    const body = document.createElement("div");
    body.className = "message-body";

    if (formatted) {
      const escaped = String(content).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[char]);

      body.innerHTML = escaped
        .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
        .replace(/`([^`]+)`/g, "<code>$1</code>");
    } else {
      body.textContent = content;
    }

    article.append(tag, body);
    $("chatLog").appendChild(article);
    $("chatLog").scrollTop = $("chatLog").scrollHeight;
  }

  function normalizeText(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // --------------------------------------------------
  // TEXT TO SPEECH
  // --------------------------------------------------

  function stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }

  function speak(text) {
    if (!$("speakToggle").checked) return;
    if (!("speechSynthesis" in window)) return;

    stopSpeaking();

    const cleanText = text
      .replace(/```[\s\S]*?```/g, " Code omitted. ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/https?:\/\/\S+/g, " link ")
      .slice(0, 3500);

    lastAssistantSpeech = normalizeText(cleanText);

    const utterance = new SpeechSynthesisUtterance(cleanText);

    utterance.lang = settings.language;
    utterance.rate = 1;
    utterance.pitch = 0.95;

    utterance.onstart = () => {
      $("voiceHint").textContent =
        listening
          ? "JARVIS SPEAKING — YOU CAN INTERRUPT"
          : "JARVIS SPEAKING";
    };

    utterance.onend = () => {
      if (listening) {
        $("voiceHint").textContent =
          "Listening continuously...";
      }
    };

    utterance.onerror = event => {
      console.warn("Speech synthesis:", event.error);
    };

    window.speechSynthesis.speak(utterance);
  }

  // --------------------------------------------------
  // GROQ API + REQUEST QUEUE
  // --------------------------------------------------

  function sendToJarvis(text) {
    const message = text.trim();

    if (!message) return;

    if (!apiKey) {
      addMessage(
        "assistant",
        "Please configure your Groq API key in settings."
      );

      $("settingsDialog").showModal();
      return;
    }

    // Display the user's message immediately.
    addMessage("user", message);

    // Queue messages so they are processed in order.
    requestQueue.push(message);
    processQueue();
  }

  async function processQueue() {
    if (processingQueue) return;

    processingQueue = true;

    while (requestQueue.length > 0) {
      const userText = requestQueue.shift();

      history.push({
        role: "user",
        content: userText
      });

      setBusy(true);
      setStatus("CONNECTING TO GROQ...");

      try {
        const response = await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Authorization": "Bearer " + apiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              model: settings.model,
              messages: [
                {
                  role: "system",
                  content: settings.systemPrompt
                },
                ...history.slice(-16)
              ],
              temperature: 0.65,
              max_completion_tokens: 1200,
              stream: false
            })
          }
        );

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data?.error?.message || "HTTP " + response.status
          );
        }

        const answer =
          data?.choices?.[0]?.message?.content?.trim();

        if (!answer) {
          throw new Error("Groq returned an empty response.");
        }

        history.push({
          role: "assistant",
          content: answer
        });

        addMessage("assistant", answer, true);
        speak(answer);

        setStatus("SYSTEM READY");

      } catch (error) {
        console.error("Groq request failed:", error);

        addMessage(
          "assistant",
          "API ERROR: " + error.message +
          "\n\nCheck your API key, model, Internet connection and Groq account limits."
        );

        setStatus("API ERROR", false);

      } finally {
        setBusy(false);
      }
    }

    processingQueue = false;
  }

  // --------------------------------------------------
  // CONTINUOUS SPEECH RECOGNITION
  // --------------------------------------------------

  function updateVoiceButton() {
    $("voiceButton").textContent = listening
      ? "■ STOP LISTENING"
      : "🎙 START CONTINUOUS LISTENING";
  }

  function startListening() {
    if (!recognition) {
      $("voiceHint").textContent =
        "Speech recognition is not supported by this browser.";
      return;
    }

    if (listening) return;

    listening = true;
    updateVoiceButton();

    $("voiceHint").textContent =
      "Starting microphone...";

    startRecognitionEngine();
  }

  function stopListening() {
    listening = false;
    restartingRecognition = false;

    updateVoiceButton();

    if (recognition) {
      try {
        recognition.stop();
      } catch {}
    }

    $("voiceHint").textContent = "Microphone stopped.";

    stopSpeaking();
  }

  function startRecognitionEngine() {
    if (!listening || !recognition || restartingRecognition) {
      return;
    }

    restartingRecognition = true;

    try {
      recognition.lang = settings.language;
      recognition.start();
    } catch (error) {
      restartingRecognition = false;
      console.warn("Recognition start:", error);
    }
  }

  function initSpeechRecognition() {
    const SpeechRecognition =
      window.SpeechRecognition ||
      window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      $("voiceButton").disabled = true;
      $("voiceHint").textContent =
        "This browser does not support speech recognition.";
      return;
    }

    recognition = new SpeechRecognition();

    recognition.lang = settings.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      restartingRecognition = false;

      if (listening) {
        $("voiceHint").textContent =
          "Listening continuously...";
      }
    };

    // Attempt to interrupt JARVIS as soon as speech is detected.
    recognition.onspeechstart = () => {
      if (
        listening &&
        "speechSynthesis" in window &&
        window.speechSynthesis.speaking
      ) {
        stopSpeaking();

        $("voiceHint").textContent =
          "JARVIS interrupted. Listening to you...";
      }
    };

    recognition.onresult = event => {
      let finalText = "";

      for (
        let i = event.resultIndex;
        i < event.results.length;
        i++
      ) {
        const result = event.results[i];

        if (result.isFinal) {
          finalText += result[0].transcript + " ";
        }
      }

      finalText = finalText.trim();

      if (!finalText) return;

      // Try to ignore JARVIS's own voice if the microphone
      // picks it up through the headset speakers.
      const normalized = normalizeText(finalText);

      if (
        lastAssistantSpeech &&
        normalized.length > 12 &&
        lastAssistantSpeech.includes(normalized)
      ) {
        return;
      }

      $("voiceHint").textContent =
        "Recognized: " + finalText;

      // Automatically send the recognized phrase.
      // No Enter key or extra button press needed.
      sendToJarvis(finalText);
    };

    recognition.onerror = event => {
      console.warn("Speech recognition error:", event.error);

      $("voiceHint").textContent =
        "Microphone error: " + event.error;

      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed"
      ) {
        listening = false;
        updateVoiceButton();
      }
    };

    recognition.onend = () => {
      restartingRecognition = false;

      // Some browsers stop recognition after a while.
      // Restart it while continuous mode is enabled.
      if (listening) {
        window.setTimeout(() => {
          startRecognitionEngine();
        }, 350);
      }
    };
  }

  // --------------------------------------------------
  // PROJECT MANAGEMENT
  // --------------------------------------------------

  function renderProjects() {
    const container = $("projectList");
    container.replaceChildren();

    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent =
        "No projects yet. Create your first project.";

      container.appendChild(empty);
      return;
    }

    projects.forEach(project => {
      const row = document.createElement("div");
      row.className = "project-item";

      const name = document.createElement("span");
      name.textContent = project.name;

      const actions = document.createElement("div");

      const open = document.createElement("button");
      open.textContent = "OPEN";
      open.onclick = () => openProject(project.id);

      const remove = document.createElement("button");
      remove.textContent = "✕";

      remove.onclick = () => {
        if (!confirm("Delete " + project.name + "?")) return;

        projects = projects.filter(
          item => item.id !== project.id
        );

        if (activeProjectId === project.id) {
          activeProjectId = null;
          $("editorName").textContent = "No file selected";
          $("codeEditor").value = "";
        }

        saveJSON(PROJECTS_KEY, projects);
        renderProjects();
      };

      actions.append(open, remove);
      row.append(name, actions);
      container.appendChild(row);
    });
  }

  function openProject(id) {
    const project = projects.find(item => item.id === id);
    if (!project) return;

    activeProjectId = id;

    $("editorName").textContent =
      project.name + " / main.txt";

    $("codeEditor").value = project.code || "";
    $("saveStatus").textContent = "PROJECT LOADED";
  }

  function createProject() {
    const name = $("projectName").value.trim();

    if (!name) {
      $("projectName").focus();
      return;
    }

    const project = {
      id: crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()),

      name,
      code: "// " + name + "\n\n",
      updated: Date.now()
    };

    projects.unshift(project);

    if (!saveJSON(PROJECTS_KEY, projects)) return;

    activeProjectId = project.id;

    renderProjects();
    openProject(project.id);

    $("projectDialog").close();
    $("projectName").value = "";
  }

  function saveCode() {
    const project = projects.find(
      item => item.id === activeProjectId
    );

    if (!project) {
      $("saveStatus").textContent = "NO PROJECT OPEN";
      return;
    }

    project.code = $("codeEditor").value;
    project.updated = Date.now();

    if (saveJSON(PROJECTS_KEY, projects)) {
      $("saveStatus").textContent = "SAVED ✓";
    }
  }

  function exportCode() {
    const project = projects.find(
      item => item.id === activeProjectId
    );

    if (!project) {
      $("saveStatus").textContent = "NO PROJECT OPEN";
      return;
    }

    const blob = new Blob(
      [$("codeEditor").value],
      { type: "text/plain;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download =
      project.name.replace(/[^a-z0-9_-]/gi, "_") + ".txt";

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
  }

  // --------------------------------------------------
  // SETTINGS
  // --------------------------------------------------

  $("settingsButton").onclick = () => {
    $("apiKey").value = apiKey;
    $("modelSelect").value = settings.model;
    $("languageSelect").value = settings.language;
    $("systemPrompt").value = settings.systemPrompt;

    $("settingsDialog").showModal();
  };

  $("saveSettings").onclick = () => {
    apiKey = $("apiKey").value.trim();

    settings = {
      model: $("modelSelect").value,
      language: $("languageSelect").value,
      systemPrompt:
        $("systemPrompt").value.trim() || DEFAULT_SYSTEM
    };

    sessionStorage.setItem("jarvis_groq_key", apiKey);
    saveJSON(SETTINGS_KEY, settings);

    $("tokenNote").textContent =
      apiKey ? "API KEY ACTIVE" : "NO API KEY";

    $("aiStatus").textContent =
      apiKey ? "READY" : "OFFLINE";

    if (recognition) {
      recognition.lang = settings.language;
    }

    $("settingsStatus").textContent =
      "Settings saved on this device.";

    $("settingsDialog").close();
  };

  $("testConnection").onclick = async () => {
    const key = $("apiKey").value.trim();

    if (!key) {
      $("settingsStatus").textContent =
        "Please enter your API key first.";
      return;
    }

    $("settingsStatus").textContent =
      "Testing Groq connection...";

    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/models",
        {
          headers: {
            "Authorization": "Bearer " + key
          }
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data?.error?.message || "HTTP " + response.status
        );
      }

      $("settingsStatus").textContent =
        "Connection successful. Groq API is reachable.";

    } catch (error) {
      console.error("Groq test:", error);

      $("settingsStatus").textContent =
        "Connection failed: " + error.message +
        ". Try testing from your GitHub Pages website.";
    }
  };

  // --------------------------------------------------
  // CHAT EVENTS
  // --------------------------------------------------

  $("chatForm").onsubmit = event => {
    event.preventDefault();

    const text = $("promptInput").value.trim();

    if (!text) return;

    $("promptInput").value = "";
    sendToJarvis(text);
  };

  $("promptInput").onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chatForm").requestSubmit();
    }
  };

  $("voiceButton").onclick = () => {
    if (listening) {
      stopListening();
    } else {
      startListening();
    }
  };

  $("speakToggle").onchange = event => {
    if (!event.target.checked) {
      stopSpeaking();
    }
  };

  $("clearChat").onclick = () => {
    history = [];
    requestQueue = [];

    $("chatLog").replaceChildren();

    addMessage(
      "assistant",
      "Conversation cleared. I am ready."
    );
  };

  // --------------------------------------------------
  // INTERFACE EVENTS
  // --------------------------------------------------

  $("focusChat").onclick = () => {
    $("promptInput").focus();
  };

  $("fullscreenButton").onclick = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      addMessage(
        "assistant",
        "Fullscreen mode was not allowed by the browser."
      );
    }
  };

  $("newProject").onclick = () => {
    $("projectDialog").showModal();
  };

  $("createProject").onclick = createProject;

  $("projectName").onkeydown = event => {
    if (event.key === "Enter") {
      createProject();
    }
  };

  $("saveCode").onclick = saveCode;
  $("downloadCode").onclick = exportCode;

  $("copyCode").onclick = async () => {
    try {
      await navigator.clipboard.writeText(
        $("codeEditor").value
      );

      $("saveStatus").textContent = "COPIED ✓";

    } catch {
      $("saveStatus").textContent =
        "COPY NOT AVAILABLE";
    }
  };

  // --------------------------------------------------
  // STARTUP
  // --------------------------------------------------

  $("tokenNote").textContent =
    apiKey ? "API KEY ACTIVE" : "NO API KEY";

  $("aiStatus").textContent =
    apiKey ? "READY" : "OFFLINE";

  renderProjects();
  initSpeechRecognition();

  if (!("speechSynthesis" in window)) {
    $("speakToggle").checked = false;
  }

  updateVoiceButton();

})();
