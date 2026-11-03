(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const PROJECTS_KEY = "jarvis_projects_v1";
  const SETTINGS_KEY = "jarvis_settings_v1";
  const CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
  const STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
  const TTS_URL = "https://api.groq.com/openai/v1/audio/speech";

  const DEFAULT_SYSTEM = `You are JARVIS, a calm, intelligent and highly capable personal AI assistant. Speak naturally and concisely. English is your primary language. You help with technology, programming, project creation and everyday tasks.

You are running in a browser on a desktop computer or Meta Quest headset. You may use ONLY the user-authorized workspace folder through the tools provided by this application.

AUTONOMOUS PROJECT CREATION:
- When the user asks you to create, build, make, design or prototype a website, game, visualization or 3D scene, CREATE IT. Do not answer with tutorials or instructions instead of doing the work.
- First inspect the workspace with list_files. Then create a sensible project folder and write all required files with write_file.
- For a browser-based 3D scene, create a complete index.html. Prefer Three.js from its public CDN, with all scene logic in the HTML unless separate files are genuinely useful.
- After writing the HTML, call preview_file with its relative path so the user sees the result immediately.
- If the user asks for a simple 3D scene, make reasonable creative decisions and produce a working first version without asking unnecessary questions.
- If no workspace is connected, explain that the user must connect a folder before you can create files. You may still explain the intended plan, but never claim a file was created.
- After tool use, report only operations confirmed by successful tool results.

WORKSPACE RULES:
- You can access files only inside the folder explicitly selected by the user. Never claim to access the rest of the PC.
- Inspect existing files before modifying them. Existing files are backed up when possible.
- Deleted files are moved to .jarvis-trash rather than permanently erased.
- Never attempt shell commands or launch native PC programs.
- HTML/CSS/JavaScript can be previewed in the browser. Native programs such as Python cannot automatically run through this static website.
- Keep answers concise, useful and natural.`;

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
  let requestQueue = [];
  let processingQueue = false;

  // Voice capture: MediaRecorder + Groq Whisper.
  let listening = false;
  let micStream = null;
  let mediaRecorder = null;
  let audioContext = null;
  let analyser = null;
  let micAnimation = 0;
  let recordingChunks = [];
  let recordingStartedAt = 0;
  let lastVoiceAt = 0;
  let speechDetected = false;
  let transcriptionBusy = false;
  let speaking = false;
  let speechQueue = [];
  let speechQueueRunning = false;
  let currentAudio = null;
  let currentAudioUrl = null;

  // Authorized workspace.
  let workspaceHandle = null;
  let activeFilePath = null;
  let activeFileHandle = null;

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

  function setStatus(message, success = true) {
    $("connectionLabel").textContent = message;
    $("connectionLabel").style.color = success ? "var(--green)" : "#ff7777";
  }

  function setBusy(value) {
    busy = value;
    const button = document.querySelector("#chatForm button[type='submit']");

    if (button) {
      button.disabled = value;
      button.style.opacity = value ? ".5" : "1";
    }

    $("aiStatus").textContent = value ? "PROCESSING" : apiKey ? "READY" : "OFFLINE";
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
      const escaped = String(content).replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]);

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

  // ---------------- VOICE OUTPUT: GROQ ORPHEUS ----------------

  function splitForTTS(text, max = 185) {
    const clean = String(text)
      .replace(/```[\s\S]*?```/g, "Code omitted.")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/https?:\/\/\S+/g, "link")
      .replace(/\s+/g, " ")
      .trim();

    const sentences = clean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [clean];
    const chunks = [];
    let current = "";

    for (const sentence of sentences) {
      const s = sentence.trim();

      if (!s) continue;

      if ((current + " " + s).trim().length <= max) {
        current = (current + " " + s).trim();
        continue;
      }

      if (current) chunks.push(current);

      if (s.length <= max) {
        current = s;
      } else {
        let rest = s;

        while (rest.length > max) {
          let cut = rest.lastIndexOf(" ", max);

          if (cut < 60) cut = max;

          chunks.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }

        current = rest;
      }
    }

    if (current) chunks.push(current);

    return chunks;
  }

  function stopSpeaking() {
    speechQueue = [];
    speechQueueRunning = false;
    speaking = false;

    if (currentAudio) {
      currentAudio.pause();
      currentAudio.src = "";
      currentAudio = null;
    }

    if (currentAudioUrl) {
      URL.revokeObjectURL(currentAudioUrl);
      currentAudioUrl = null;
    }

    if (listening) {
      $("voiceHint").textContent = "Listening continuously...";
    }
  }

  async function generateSpeech(text) {
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "canopylabs/orpheus-v1-english",
        voice: "troy",
        input: text,
        response_format: "wav"
      })
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error?.message || "TTS HTTP " + response.status);
    }

    return await response.blob();
  }

  async function runSpeechQueue() {
    if (speechQueueRunning) return;

    speechQueueRunning = true;
    speaking = true;

    try {
      while (speechQueue.length) {
        const chunk = speechQueue.shift();

        if (!$("speakToggle").checked) break;

        if (settings.language !== "en-US") {
          $("voiceHint").textContent = "Neural voice currently supports English only. Set voice language to English.";
          break;
        }

        $("voiceHint").textContent = "JARVIS generating voice...";

        const blob = await generateSpeech(chunk);

        if (!$("speakToggle").checked) break;

        currentAudioUrl = URL.createObjectURL(blob);
        currentAudio = new Audio(currentAudioUrl);
        currentAudio.preload = "auto";

        $("voiceHint").textContent = "JARVIS speaking...";

        await new Promise((resolve, reject) => {
          currentAudio.onended = resolve;

          currentAudio.onerror = () => reject(
            new Error("The generated audio could not be played by this browser.")
          );

          const p = currentAudio.play();

          if (p?.catch) p.catch(reject);
        });

        currentAudio = null;
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
      }
    } catch (error) {
      console.error("Neural TTS error:", error);
      $("voiceHint").textContent = "Voice generation failed: " + error.message;
    } finally {
      speechQueueRunning = false;
      speaking = false;

      if (listening && !transcriptionBusy) {
        $("voiceHint").textContent = "Listening continuously...";
      }
    }
  }

  function speak(text) {
    if (!$("speakToggle").checked || !apiKey) return;

    stopSpeaking();
    speechQueue = splitForTTS(text);

    if (speechQueue.length) runSpeechQueue();
  }

  // ---------------- WORKSPACE FILE SYSTEM ----------------

  function requireWorkspace() {
    if (!workspaceHandle) {
      throw new Error("No workspace folder is connected. Connect a folder first.");
    }
  }

  function validatePath(path) {
    if (typeof path !== "string") {
      throw new Error("Invalid file path.");
    }

    const normalized = path.replace(/\\/g, "/").trim();

    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
      throw new Error("Absolute paths are not allowed.");
    }

    const parts = normalized.split("/").filter(Boolean);

    if (parts.some(p => p === "." || p === ".." || p.includes("\0"))) {
      throw new Error("This path is not allowed.");
    }

    if (parts.some(p => p === ".jarvis-backups" || p === ".jarvis-trash")) {
      throw new Error("JARVIS internal folders cannot be modified directly.");
    }

    return parts;
  }

  async function getDirectory(parts, create = false) {
    requireWorkspace();

    let dir = workspaceHandle;

    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }

    return dir;
  }

  async function getFileHandle(path, create = false) {
    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("A file path is required.");
    }

    const parent = await getDirectory(parts.slice(0, -1), create);

    return parent.getFileHandle(parts.at(-1), { create });
  }

  async function readWorkspaceFile(path) {
    const handle = await getFileHandle(path);
    const file = await handle.getFile();

    if (file.size > 2_000_000) {
      throw new Error("This file is larger than 2 MB.");
    }

    return file.text();
  }

  async function writeWorkspaceFile(path, content) {
    requireWorkspace();

    if (typeof content !== "string") {
      throw new Error("File content must be text.");
    }

    if (content.length > 1_500_000) {
      throw new Error("This file is too large.");
    }

    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("A file path is required.");
    }

    const filename = parts.at(-1);
    const parent = await getDirectory(parts.slice(0, -1), true);

    let existing = null;

    try {
      existing = await parent.getFileHandle(filename);
    } catch {}

    if (existing) {
      const old = await existing.getFile();

      if (old.size <= 1_500_000) {
        const backupDir = await getDirectory([".jarvis-backups"], true);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");

        const backup = await backupDir.getFileHandle(
          filename + "." + stamp + ".bak",
          { create: true }
        );

        const bw = await backup.createWritable();
        await bw.write(await old.arrayBuffer());
        await bw.close();
      }
    }

    const handle = await parent.getFileHandle(filename, { create: true });
    const writer = await handle.createWritable();

    await writer.write(content);
    await writer.close();

    return `Successfully saved ${path}.`;
  }

  async function listWorkspaceFolder(path = "") {
    requireWorkspace();

    const parts = validatePath(path);
    const dir = await getDirectory(parts);
    const entries = [];

    for await (const [name, handle] of dir.entries()) {
      if (parts.length === 0 && [".jarvis-backups", ".jarvis-trash"].includes(name)) {
        continue;
      }

      entries.push({
        name,
        kind: handle.kind,
        path: [...parts, name].join("/")
      });
    }

    entries.sort((a, b) =>
      a.kind !== b.kind
        ? (a.kind === "directory" ? -1 : 1)
        : a.name.localeCompare(b.name)
    );

    return entries;
  }

  async function createWorkspaceDirectory(path) {
    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("A directory path is required.");
    }

    await getDirectory(parts, true);
    await refreshFileTree();

    return `Directory created: ${path}`;
  }

  async function moveFileToTrash(path) {
    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("Invalid file path.");
    }

    const filename = parts.at(-1);
    const source = await getFileHandle(path);
    const file = await source.getFile();
    const trash = await getDirectory([".jarvis-trash"], true);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const target = await trash.getFileHandle(
      filename + "." + stamp + ".deleted",
      { create: true }
    );

    const writer = await target.createWritable();

    await writer.write(await file.arrayBuffer());
    await writer.close();

    await (await getDirectory(parts.slice(0, -1))).removeEntry(filename);
    await refreshFileTree();

    return `${path} moved to .jarvis-trash. It was not permanently deleted.`;
  }

  // ---------------- FILE EXPLORER ----------------

  async function refreshFileTree() {
    const tree = $("fileTree");

    if (!workspaceHandle) {
      tree.innerHTML = '<div class="empty-state">Connect a folder to browse its files.</div>';
      return;
    }

    tree.replaceChildren();

    async function renderInto(container, path, depth) {
      const entries = await listWorkspaceFolder(path);

      for (const entry of entries) {
        const button = document.createElement("button");

        button.className = "file-entry " +
          (entry.kind === "directory" ? "directory" : "file");

        button.style.paddingLeft = `${7 + depth * 15}px`;

        const icon = document.createElement("span");
        icon.textContent = entry.kind === "directory" ? "📁" : "📄";

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = entry.name;

        button.append(icon, name);
        container.appendChild(button);

        if (entry.kind === "file") {
          button.addEventListener("click", () => openWorkspaceFile(entry.path));
        } else {
          button.addEventListener("click", async () => {
            const selector = `[data-folder="${CSS.escape(entry.path)}"]`;
            const found = container.querySelector(selector);

            if (found) {
              found.remove();
              return;
            }

            const holder = document.createElement("div");
            holder.dataset.folder = entry.path;
            button.after(holder);

            try {
              await renderInto(holder, entry.path, depth + 1);
            } catch (e) {
              holder.textContent = e.message;
            }
          });
        }
      }
    }

    await renderInto(tree, "", 0);

    if (!tree.children.length) {
      tree.innerHTML = '<div class="empty-state">This folder is empty.</div>';
    }
  }

  async function openWorkspaceFile(path) {
    try {
      const handle = await getFileHandle(path);
      const file = await handle.getFile();

      if (file.size > 2_000_000) {
        throw new Error("This file is too large to open in the editor.");
      }

      activeFilePath = path;
      activeFileHandle = handle;
      activeProjectId = null;

      $("editorName").textContent = path;
      $("codeEditor").value = await file.text();
      $("saveStatus").textContent = "PC FILE OPENED";
      $("runPreview").disabled = !path.toLowerCase().endsWith(".html");

      document.querySelectorAll(".file-entry").forEach(el => {
        el.classList.remove("active");
      });

      const match = [...document.querySelectorAll(".file-entry")]
        .find(el => el.textContent.trim() === path.split("/").at(-1));

      match?.classList.add("active");
    } catch (error) {
      addMessage("assistant", "I couldn't open that file: " + error.message);
    }
  }

  async function saveActiveFile() {
    if (activeFilePath) {
      await writeWorkspaceFile(activeFilePath, $("codeEditor").value);
      $("saveStatus").textContent = "PC FILE SAVED ✓";
      await refreshFileTree();
    } else {
      saveCode();
    }
  }

  // ---------------- PREVIEW ----------------

  async function previewHtmlFile(path) {
    if (!path.toLowerCase().endsWith(".html")) {
      throw new Error("Only HTML files can be previewed.");
    }

    const html = await readWorkspaceFile(path);

    $("projectPreview").srcdoc = html;
    $("previewStatus").textContent = "PREVIEW: " + path;
  }

  function previewCurrentProject() {
    const project = projects.find(p => p.id === activeProjectId);

    if (!project) {
      addMessage("assistant", "Select a project before trying to preview it.");
      return;
    }

    $("projectPreview").srcdoc = project.code;
    $("previewStatus").textContent = "LOCAL PROJECT PREVIEW";
  }

  // ---------------- MODEL TOOLS ----------------

  const availableTools = [
    {
      type: "function",
      function: {
        name: "list_files",
        description: "List files and folders in the authorized workspace. Use empty path for root.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a text file from the authorized workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or replace a text file. Existing files are backed up when possible.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" }
          },
          required: ["path", "content"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_directory",
        description: "Create a directory inside the authorized workspace.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "delete_file",
        description: "Move a file to .jarvis-trash, not permanent deletion.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "preview_file",
        description: "Load an HTML file from the workspace into the project preview. Use after creating or updating the HTML page.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" }
          },
          required: ["path"]
        }
      }
    }
  ];

  async function executeTool(name, args) {
    switch (name) {
      case "list_files":
        return JSON.stringify(
          await listWorkspaceFolder(args.path || ""),
          null,
          2
        );

      case "read_file":
        return await readWorkspaceFile(args.path);

      case "write_file": {
        const result = await writeWorkspaceFile(args.path, args.content);
        await refreshFileTree();
        return result;
      }

      case "create_directory":
        return await createWorkspaceDirectory(args.path);

      case "delete_file":
        return await moveFileToTrash(args.path);

      case "preview_file":
        await previewHtmlFile(args.path);
        return `Preview loaded successfully: ${args.path}`;

      default:
        throw new Error("Unknown tool: " + name);
    }
  }

  async function groqRequest(messages) {
    const response = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        tools: availableTools,
        tool_choice: "auto",
        parallel_tool_calls: false,
        temperature: 0.35,
        max_completion_tokens: 2400,
        stream: false
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.error?.message || "HTTP " + response.status);
    }

    return data?.choices?.[0]?.message;
  }

  async function processAgentRequest(userText) {
    const messages = [
      {
        role: "system",
        content: settings.systemPrompt +
          "\n\nWorkspace connected: " +
          (workspaceHandle ? workspaceHandle.name : "No") +
          ". If the user requests file creation without a connected workspace, clearly request connection; do not pretend. When creating a 3D scene or web project, use tools to create a complete working page and call preview_file."
      },
      ...history.slice(-16)
    ];

    let response = null;
    let step = 0;

    while (step < 8) {
      step++;

      response = await groqRequest(messages);

      if (!response) {
        throw new Error("The AI returned an empty response.");
      }

      messages.push(response);

      if (!response.tool_calls?.length) break;

      for (const call of response.tool_calls) {
        let result;

        try {
          const args = JSON.parse(call.function.arguments || "{}");

          if (!workspaceHandle) {
            throw new Error("No PC folder is connected. Connect a folder before asking me to access files.");
          }

          result = await executeTool(call.function.name, args);
        } catch (error) {
          result = "Tool error: " + error.message;
        }

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.function.name,
          content: String(result).slice(0, 14000)
        });
      }
    }

    if (response?.tool_calls?.length && step >= 8) {
      messages.push({
        role: "system",
        content: "Tool-call limit reached. Summarize only what has actually been completed and what remains."
      });

      response = await groqRequest(messages);
    }

    return response?.content?.trim() || "The requested operations have been processed.";
  }

  // ---------------- CHAT QUEUE ----------------

  function sendToJarvis(text) {
    const message = text.trim();

    if (!message) return;

    if (!apiKey) {
      addMessage("assistant", "Please configure your Groq API key in settings.");
      $("settingsDialog").showModal();
      return;
    }

    addMessage("user", message);
    requestQueue.push(message);
    processQueue();
  }

  async function processQueue() {
    if (processingQueue) return;

    processingQueue = true;

    while (requestQueue.length) {
      const userText = requestQueue.shift();

      history.push({
        role: "user",
        content: userText
      });

      setBusy(true);
      setStatus("CONNECTING TO JARVIS...");

      try {
        const answer = await processAgentRequest(userText);

        history.push({
          role: "assistant",
          content: answer
        });

        if (history.length > 30) {
          history = history.slice(-24);
        }

        addMessage("assistant", answer, true);
        speak(answer);
        setStatus("SYSTEM READY");
      } catch (error) {
        console.error("JARVIS request failed:", error);

        addMessage(
          "assistant",
          "SYSTEM ERROR: " + error.message +
          "\n\nCheck your API key, model, Internet connection and Groq account limits."
        );

        setStatus("API ERROR", false);
      } finally {
        setBusy(false);
      }
    }

    processingQueue = false;
  }

  // ---------------- MICROPHONE: VAD + MEDIARECORDER + WHISPER ----------------

  function updateVoiceButton() {
    $("voiceButton").textContent = listening
      ? "■ STOP LISTENING"
      : "🎙 START CONTINUOUS LISTENING";
  }

  function supportedMimeType() {
    const types = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];

    return types.find(type =>
      window.MediaRecorder?.isTypeSupported?.(type)
    ) || "";
  }

  async function transcribeBlob(blob) {
    if (!blob || blob.size < 1200 || transcriptionBusy) return;

    transcriptionBusy = true;
    $("voiceHint").textContent = "Transcribing your speech...";

    try {
      const form = new FormData();

      const ext = blob.type.includes("ogg")
        ? "ogg"
        : blob.type.includes("mp4")
          ? "mp4"
          : "webm";

      form.append("file", blob, "jarvis-recording." + ext);
      form.append("model", "whisper-large-v3-turbo");
      form.append("language", settings.language === "fr-FR" ? "fr" : "en");
      form.append("response_format", "json");
      form.append("temperature", "0");

      const response = await fetch(STT_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey
        },
        body: form
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error?.message || "Whisper HTTP " + response.status);
      }

      const transcript = String(data.text || "").trim();

      if (transcript && listening) {
        $("voiceHint").textContent = "Recognized: " + transcript;
        sendToJarvis(transcript);
      } else if (listening) {
        $("voiceHint").textContent = "Listening continuously...";
      }
    } catch (error) {
      console.error("Whisper error:", error);
      $("voiceHint").textContent = "Transcription failed: " + error.message;
    } finally {
      transcriptionBusy = false;
    }
  }

  function beginRecording() {
    if (!listening || !micStream || mediaRecorder || speaking) return;

    try {
      const mimeType = supportedMimeType();

      mediaRecorder = new MediaRecorder(
        micStream,
        mimeType ? { mimeType } : undefined
      );

      recordingChunks = [];
      speechDetected = false;
      recordingStartedAt = Date.now();
      lastVoiceAt = 0;

      mediaRecorder.ondataavailable = event => {
        if (event.data?.size) {
          recordingChunks.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const type = mediaRecorder?.mimeType || mimeType || "audio/webm";
        const blob = new Blob(recordingChunks, { type });

        mediaRecorder = null;
        recordingChunks = [];

        if (speechDetected) {
          transcribeBlob(blob);
        }

        if (listening) {
          setTimeout(beginRecording, 180);
        }
      };

      mediaRecorder.start(250);
      $("voiceHint").textContent = "Listening continuously...";
    } catch (error) {
      console.error("Recorder start:", error);
      $("voiceHint").textContent = "Recording error: " + error.message;
    }
  }

  function monitorMicrophone() {
    if (!listening || !analyser) return;

    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);

    let sum = 0;

    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }

    const rms = Math.sqrt(sum / data.length);
    const now = Date.now();

    // Adaptive-ish threshold: suppress room noise while still detecting normal speech.
    if (rms > 0.025) {
      speechDetected = true;
      lastVoiceAt = now;
    }

    if (
      mediaRecorder?.state === "recording" &&
      speechDetected &&
      now - lastVoiceAt > 1150 &&
      now - recordingStartedAt > 650
    ) {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    // Avoid sending JARVIS audio back to Whisper. Restart recording after TTS completes.
    if (speaking && mediaRecorder?.state === "recording") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    micAnimation = requestAnimationFrame(monitorMicrophone);
  }

  async function startListening() {
    if (listening) return;

    if (!apiKey) {
      $("voiceHint").textContent = "Configure your Groq API key before using the microphone.";
      $("settingsDialog").showModal();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      $("voiceHint").textContent = "This browser does not support microphone recording. Use a recent browser over HTTPS.";
      return;
    }

    try {
      listening = true;
      updateVoiceButton();

      $("voiceHint").textContent = "Requesting microphone permission...";

      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      const AudioContextClass = window.AudioContext || window.webkitAudioContext;

      audioContext = new AudioContextClass();
      await audioContext.resume();

      const source = audioContext.createMediaStreamSource(micStream);

      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;

      source.connect(analyser);

      beginRecording();
      monitorMicrophone();
    } catch (error) {
      listening = false;
      updateVoiceButton();

      $("voiceHint").textContent =
        "Microphone access failed: " + error.message +
        ". Check Opera's site microphone permission and Windows input settings.";

      stopListening(false);
    }
  }

  function stopListening(updateHint = true) {
    listening = false;
    updateVoiceButton();

    cancelAnimationFrame(micAnimation);

    if (mediaRecorder?.state === "recording") {
      try {
        mediaRecorder.stop();
      } catch {}
    }

    if (micStream) {
      micStream.getTracks().forEach(track => track.stop());
      micStream = null;
    }

    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }

    analyser = null;

    if (updateHint) {
      $("voiceHint").textContent = "Microphone stopped.";
    }

    stopSpeaking();
  }

  // ---------------- CONNECT / DISCONNECT WORKSPACE ----------------

  async function connectWorkspace() {
    if (!window.showDirectoryPicker) {
      addMessage(
        "assistant",
        "This browser does not support direct folder access. Use a recent desktop Chromium browser over HTTPS."
      );
      return;
    }

    try {
      const selected = await window.showDirectoryPicker({ mode: "readwrite" });

      const permission = await selected.requestPermission({
        mode: "readwrite"
      });

      if (permission !== "granted") {
        throw new Error("Read/write permission was not granted.");
      }

      workspaceHandle = selected;

      $("workspaceStatus").textContent = "CONNECTED";
      $("workspaceDescription").textContent = selected.name;

      $("folderPermissionBadge").textContent = "READ / WRITE AUTHORIZED";
      $("folderPermissionBadge").classList.add("connected");

      $("folderDescription").textContent =
        "JARVIS can now manage files inside this folder.";

      $("folderPath").textContent = "Authorized folder: " + selected.name;
      $("disconnectFolder").disabled = false;

      await refreshFileTree();

      addMessage(
        "assistant",
        `Workspace connected: ${selected.name}. I can now manage files inside this folder only.`
      );
    } catch (error) {
      if (error.name !== "AbortError") {
        addMessage("assistant", "Folder connection failed: " + error.message);
      }
    }
  }

  function disconnectWorkspace() {
    workspaceHandle = null;
    activeFilePath = null;
    activeFileHandle = null;

    $("workspaceStatus").textContent = "DISCONNECTED";
    $("workspaceDescription").textContent = "No folder authorized";

    $("folderPermissionBadge").textContent = "NOT CONNECTED";
    $("folderPermissionBadge").classList.remove("connected");

    $("folderDescription").textContent =
      "Authorize a folder to let JARVIS create, read and edit files inside it.";

    $("folderPath").textContent = "No folder selected";
    $("disconnectFolder").disabled = true;

    $("fileTree").innerHTML =
      '<div class="empty-state">Connect a folder to browse its files.</div>';

    $("editorName").textContent = "No file selected";
    $("codeEditor").value = "";
    $("saveStatus").textContent = "READY";
    $("runPreview").disabled = true;

    addMessage("assistant", "The PC workspace has been disconnected.");
  }

  // ---------------- PROJECTS ----------------

  function renderProjects() {
    const container = $("projectList");
    container.replaceChildren();

    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No projects yet. Create your first project.";
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

        projects = projects.filter(p => p.id !== project.id);

        if (activeProjectId === project.id) {
          activeProjectId = null;
          activeFilePath = null;
          $("editorName").textContent = "No file selected";
          $("codeEditor").value = "";
          $("runPreview").disabled = true;
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
    const project = projects.find(p => p.id === id);

    if (!project) return;

    activeProjectId = id;
    activeFilePath = null;
    activeFileHandle = null;

    $("editorName").textContent = project.name + " / main.txt";
    $("codeEditor").value = project.code || "";
    $("saveStatus").textContent = "PROJECT LOADED";
    $("runPreview").disabled = false;
  }

  function createProject() {
    const name = $("projectName").value.trim();

    if (!name) {
      $("projectName").focus();
      return;
    }

    const project = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
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
    const project = projects.find(p => p.id === activeProjectId);

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
    const content = $("codeEditor").value;

    if (!content.trim()) {
      $("saveStatus").textContent = "NOTHING TO EXPORT";
      return;
    }

    const project = projects.find(p => p.id === activeProjectId);

    const filename = activeFilePath
      ? activeFilePath.split("/").at(-1)
      : (project?.name || "jarvis-project") + ".txt";

    const blob = new Blob([content], {
      type: "text/plain;charset=utf-8"
    });

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------- SETTINGS ----------------

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
      systemPrompt: $("systemPrompt").value.trim() || DEFAULT_SYSTEM
    };

    if (apiKey) {
      sessionStorage.setItem("jarvis_groq_key", apiKey);
    } else {
      sessionStorage.removeItem("jarvis_groq_key");
    }

    saveJSON(SETTINGS_KEY, settings);

    $("tokenNote").textContent = apiKey ? "API KEY ACTIVE" : "NO API KEY";
    $("aiStatus").textContent = apiKey ? "READY" : "OFFLINE";

    $("settingsStatus").textContent = "Settings saved on this device.";
    $("settingsDialog").close();
  };

  $("testConnection").onclick = async () => {
    const key = $("apiKey").value.trim();

    if (!key) {
      $("settingsStatus").textContent = "Please enter your API key first.";
      return;
    }

    $("settingsStatus").textContent = "Testing Groq connection...";

    try {
      const response = await fetch(
        "https://api.groq.com/openai/v1/models",
        {
          headers: {
            Authorization: "Bearer " + key
          }
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data?.error?.message || "HTTP " + response.status);
      }

      $("settingsStatus").textContent =
        "Connection successful. Groq API is reachable.";
    } catch (error) {
      $("settingsStatus").textContent =
        "Connection failed: " + error.message;
    }
  };

  // ---------------- UI EVENTS ----------------

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
    listening ? stopListening() : startListening();
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

    addMessage("assistant", "Conversation cleared. I am ready.");
  };

  $("focusChat").onclick = () => $("promptInput").focus();

  $("fullscreenButton").onclick = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      addMessage("assistant", "Fullscreen mode was not allowed by the browser.");
    }
  };

  $("newProject").onclick = () => $("projectDialog").showModal();
  $("createProject").onclick = createProject;

  $("projectName").onkeydown = event => {
    if (event.key === "Enter") createProject();
  };

  $("saveCode").onclick = () => {
    saveActiveFile().catch(error =>
      addMessage("assistant", "Save failed: " + error.message)
    );
  };

  $("downloadCode").onclick = exportCode;

  $("copyCode").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("codeEditor").value);
      $("saveStatus").textContent = "COPIED ✓";
    } catch {
      $("saveStatus").textContent = "COPY NOT AVAILABLE";
    }
  };

  $("connectFolder").onclick = connectWorkspace;
  $("disconnectFolder").onclick = disconnectWorkspace;

  $("refreshFiles").onclick = () => {
    refreshFileTree().catch(error =>
      addMessage("assistant", "Could not refresh files: " + error.message)
    );
  };

  $("runPreview").onclick = async () => {
    try {
      if (activeFilePath) {
        await previewHtmlFile(activeFilePath);
      } else {
        previewCurrentProject();
      }
    } catch (error) {
      addMessage("assistant", "Preview failed: " + error.message);
    }
  };

  // ---------------- STARTUP ----------------

  $("tokenNote").textContent = apiKey ? "API KEY ACTIVE" : "NO API KEY";
  $("aiStatus").textContent = apiKey ? "READY" : "OFFLINE";
  $("systemPrompt").value = settings.systemPrompt;

  renderProjects();
  updateVoiceButton();

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $("voiceButton").disabled = true;

    $("voiceHint").textContent =
      "Microphone recording is not supported in this browser. Use a recent browser over HTTPS.";
  } else {
    $("voiceHint").textContent =
      "Press START and allow microphone access. Speech is transcribed by Groq Whisper.";
  }

  if (!window.showDirectoryPicker) {
    $("folderDescription").textContent =
      "This browser does not support direct folder access. Try a recent desktop Chromium browser.";
  }
})();
