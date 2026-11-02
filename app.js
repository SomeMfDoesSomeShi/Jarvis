(() => {
  "use strict";

  const $ = id => document.getElementById(id);

  const PROJECTS_KEY = "jarvis_projects_v1";
  const SETTINGS_KEY = "jarvis_settings_v1";
  const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

  const DEFAULT_SYSTEM = `
You are JARVIS, a calm, intelligent and highly capable personal AI assistant.
You speak naturally and concisely. English is your primary language.
You help with technology, programming, project creation and everyday tasks.

You are running in a browser on a Meta Quest headset or desktop computer.
You have access to a user-authorized workspace folder through the available tools.

IMPORTANT WORKSPACE RULES:
- You can only access files inside the folder explicitly selected by the user.
- Never claim to access the rest of the PC.
- Use the file tools to inspect, create, read and modify project files.
- You can autonomously complete multi-step projects using the available tools.
- Inspect existing files before modifying them.
- When replacing a file, the application creates a backup when possible.
- Deleted files are moved to .jarvis-trash rather than permanently erased.
- Do not invent successful file operations. Check tool results.
- Do not attempt to execute shell commands or launch native PC programs.
- HTML, CSS and JavaScript projects can be previewed in the browser.
- Python and other native programs cannot automatically run through this static website.
- Explain limitations clearly.
- Keep answers concise, useful and natural.
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

  // FILE WORKSPACE STATE
  let workspaceHandle = null;
  let activeFilePath = null;
  let activeFileHandle = null;

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
  // FILE SYSTEM ACCESS
  // --------------------------------------------------

  function hasWorkspace() {
    return workspaceHandle !== null;
  }

  function requireWorkspace() {
    if (!workspaceHandle) {
      throw new Error(
        "No workspace folder is connected. Ask the user to connect a folder first."
      );
    }
  }

  function validatePath(path) {
    if (typeof path !== "string") {
      throw new Error("Invalid file path.");
    }

    const normalized = path.replace(/\\/g, "/").trim();

    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(normalized)
    ) {
      throw new Error("Absolute paths are not allowed.");
    }

    const parts = normalized.split("/").filter(Boolean);

    if (
      parts.some(part =>
        part === "." ||
        part === ".." ||
        part.includes("\0")
      )
    ) {
      throw new Error("This path is not allowed.");
    }

    return parts;
  }

  async function getDirectory(parts, create = false) {
    requireWorkspace();

    let directory = workspaceHandle;

    for (const part of parts) {
      directory = await directory.getDirectoryHandle(
        part,
        { create }
      );
    }

    return directory;
  }

  async function getFileHandle(path, create = false) {
    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("A file path is required.");
    }

    const directory = await getDirectory(
      parts.slice(0, -1),
      create
    );

    return directory.getFileHandle(
      parts[parts.length - 1],
      { create }
    );
  }

  async function readWorkspaceFile(path) {
    const handle = await getFileHandle(path);
    const file = await handle.getFile();

    if (file.size > 2_000_000) {
      throw new Error(
        "This file is larger than 2 MB. It cannot be loaded into the editor."
      );
    }

    return await file.text();
  }

  async function writeWorkspaceFile(path, content) {
    requireWorkspace();

    if (typeof content !== "string") {
      throw new Error("File content must be text.");
    }

    if (content.length > 1_500_000) {
      throw new Error("This file is too large for the workspace editor.");
    }

    const parts = validatePath(path);

    if (!parts.length) {
      throw new Error("A file path is required.");
    }

    const filename = parts[parts.length - 1];
    const parent = await getDirectory(
      parts.slice(0, -1),
      true
    );

    // Keep a backup when a file is overwritten.
    let existingHandle = null;

    try {
      existingHandle = await parent.getFileHandle(filename);
    } catch {
      // File does not exist yet.
    }

    if (existingHandle) {
      const oldFile = await existingHandle.getFile();

      if (oldFile.size <= 1_500_000) {
        const backupDirectory = await getDirectory(
          [".jarvis-backups"],
          true
        );

        const timestamp = new Date()
          .toISOString()
          .replace(/[:.]/g, "-");

        const backupName =
          filename + "." + timestamp + ".bak";

        const backupHandle =
          await backupDirectory.getFileHandle(
            backupName,
            { create: true }
          );

        const backupWriter =
          await backupHandle.createWritable();

        await backupWriter.write(await oldFile.text());
        await backupWriter.close();
      }
    }

    const fileHandle = await parent.getFileHandle(
      filename,
      { create: true }
    );

    const writer = await fileHandle.createWritable();

    await writer.write(content);
    await writer.close();

    return `Successfully saved ${path}.`;
  }

  async function listWorkspaceFolder(path = "") {
    requireWorkspace();

    const parts = validatePath(path);
    const directory = await getDirectory(parts);
    const entries = [];

    for await (const [name, handle] of directory.entries()) {
      if (
        parts.length === 0 &&
        (name === ".jarvis-backups" ||
         name === ".jarvis-trash")
      ) {
        continue;
      }

      entries.push({
        name,
        kind: handle.kind,
        path: [...parts, name].join("/")
      });
    }

    entries.sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === "directory" ? -1 : 1;
      }

      return a.name.localeCompare(b.name);
    });

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

    const filename = parts[parts.length - 1];
    const sourceHandle = await getFileHandle(path);
    const sourceFile = await sourceHandle.getFile();

    const trashDirectory = await getDirectory(
      [".jarvis-trash"],
      true
    );

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const trashName = `${filename}.${timestamp}.deleted`;

    const trashHandle = await trashDirectory.getFileHandle(
      trashName,
      { create: true }
    );

    const writer = await trashHandle.createWritable();

    await writer.write(await sourceFile.arrayBuffer());
    await writer.close();

    const parent = await getDirectory(parts.slice(0, -1));

    await parent.removeEntry(filename);

    await refreshFileTree();

    return `${path} was moved to .jarvis-trash. It was not permanently deleted.`;
  }

  // --------------------------------------------------
  // FILE EXPLORER
  // --------------------------------------------------

  async function refreshFileTree() {
    const tree = $("fileTree");

    if (!workspaceHandle) {
      tree.innerHTML =
        '<div class="empty-state">Connect a folder to browse its files.</div>';
      return;
    }

    tree.replaceChildren();

    async function renderDirectory(path = "", depth = 0) {
      const entries = await listWorkspaceFolder(path);

      for (const entry of entries) {
        const button = document.createElement("button");

        button.className =
          "file-entry " +
          (entry.kind === "directory" ? "directory" : "file");

        button.style.paddingLeft =
          `${7 + depth * 15}px`;

        const icon = document.createElement("span");
        icon.textContent =
          entry.kind === "directory" ? "📁" : "📄";

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = entry.name;

        button.append(icon, name);

        if (entry.kind === "file") {
          button.addEventListener("click", () => {
            openWorkspaceFile(entry.path);
          });
        } else {
          button.addEventListener("click", async () => {
            const existing = tree.querySelector(
              `[data-folder="${CSS.escape(entry.path)}"]`
            );

            if (existing) {
              existing.remove();
              return;
            }

            const holder = document.createElement("div");
            holder.dataset.folder = entry.path;

            button.after(holder);

            await renderDirectoryInto(
              holder,
              entry.path,
              depth + 1
            );
          });
        }

        tree.appendChild(button);
      }
    }

    async function renderDirectoryInto(
      container,
      path,
      depth
    ) {
      const entries = await listWorkspaceFolder(path);

      for (const entry of entries) {
        const button = document.createElement("button");

        button.className =
          "file-entry " +
          (entry.kind === "directory" ? "directory" : "file");

        button.style.paddingLeft =
          `${7 + depth * 15}px`;

        const icon = document.createElement("span");
        icon.textContent =
          entry.kind === "directory" ? "📁" : "📄";

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = entry.name;

        button.append(icon, name);

        if (entry.kind === "file") {
          button.addEventListener("click", () => {
            openWorkspaceFile(entry.path);
          });
        } else {
          button.addEventListener("click", async () => {
            const existing = container.querySelector(
              `[data-folder="${CSS.escape(entry.path)}"]`
            );

            if (existing) {
              existing.remove();
              return;
            }

            const holder = document.createElement("div");
            holder.dataset.folder = entry.path;

            button.after(holder);

            await renderDirectoryInto(
              holder,
              entry.path,
              depth + 1
            );
          });
        }

        container.appendChild(button);
      }
    }

    await renderDirectory();

    if (!tree.children.length) {
      tree.innerHTML =
        '<div class="empty-state">This folder is empty.</div>';
    }
  }

  async function openWorkspaceFile(path) {
    try {
      const handle = await getFileHandle(path);
      const file = await handle.getFile();

      if (file.size > 2_000_000) {
        throw new Error(
          "This file is too large to open in the editor."
        );
      }

      const content = await file.text();

      activeFilePath = path;
      activeFileHandle = handle;
      activeProjectId = null;

      $("editorName").textContent = path;
      $("codeEditor").value = content;
      $("saveStatus").textContent = "PC FILE OPENED";

      $("runPreview").disabled =
        !path.toLowerCase().endsWith(".html");

      document.querySelectorAll(".file-entry").forEach(item => {
        item.classList.remove("active");
      });

      const matching = [...document.querySelectorAll(".file-entry")]
        .find(item => item.textContent.trim().endsWith(path.split("/").pop()));

      matching?.classList.add("active");

    } catch (error) {
      addMessage(
        "assistant",
        "I couldn't open that file: " + error.message
      );
    }
  }

  async function saveActiveFile() {
    if (activeFilePath) {
      await writeWorkspaceFile(
        activeFilePath,
        $("codeEditor").value
      );

      $("saveStatus").textContent = "PC FILE SAVED ✓";

      await refreshFileTree();

      return;
    }

    saveCode();
  }

  // --------------------------------------------------
  // PROJECT PREVIEW
  // --------------------------------------------------

  async function previewHtmlFile(path) {
    const html = await readWorkspaceFile(path);

    $("projectPreview").srcdoc = html;
    $("previewStatus").textContent = "PREVIEW: " + path;
  }

  function previewCurrentProject() {
    const project = projects.find(
      item => item.id === activeProjectId
    );

    if (!project) {
      addMessage(
        "assistant",
        "Select a project before trying to preview it."
      );
      return;
    }

    $("projectPreview").srcdoc = project.code;
    $("previewStatus").textContent =
      "LOCAL PROJECT PREVIEW";
  }

  // --------------------------------------------------
  // GROQ TOOLS
  // --------------------------------------------------

  const availableTools = [
    {
      type: "function",
      function: {
        name: "list_files",
        description:
          "List files and folders in the authorized workspace. Use an empty path for the root folder.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative folder path."
            }
          },
          required: ["path"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file from the authorized workspace.",
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
        description:
          "Create or replace a text file in the authorized workspace. Existing files are backed up when possible.",
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
        description:
          "Create a directory inside the authorized workspace.",
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
        description:
          "Move a file into .jarvis-trash inside the authorized workspace. This does not permanently delete it.",
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
        description:
          "Display an HTML file from the authorized workspace in the project preview.",
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
      case "list_files": {
        const entries = await listWorkspaceFolder(
          args.path || ""
        );

        return JSON.stringify(entries, null, 2);
      }

      case "read_file": {
        return await readWorkspaceFile(args.path);
      }

      case "write_file": {
        const result = await writeWorkspaceFile(
          args.path,
          args.content
        );

        await refreshFileTree();

        return result;
      }

      case "create_directory": {
        return await createWorkspaceDirectory(args.path);
      }

      case "delete_file": {
        return await moveFileToTrash(args.path);
      }

      case "preview_file": {
        if (!args.path.toLowerCase().endsWith(".html")) {
          throw new Error("Only HTML files can be previewed.");
        }

        await previewHtmlFile(args.path);

        return `Preview loaded: ${args.path}`;
      }

      default:
        throw new Error("Unknown tool: " + name);
    }
  }

  // --------------------------------------------------
  // GROQ API
  // --------------------------------------------------

  async function groqRequest(messages) {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: settings.model,
        messages,
        tools: availableTools,
        tool_choice: "auto",
        temperature: 0.5,
        max_completion_tokens: 1800,
        stream: false
      })
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data?.error?.message || "HTTP " + response.status
      );
    }

    return data?.choices?.[0]?.message;
  }

  async function processAgentRequest(userText) {
    const messages = [
      {
        role: "system",
        content:
          settings.systemPrompt +
          "\n\nWorkspace connected: " +
          (workspaceHandle ? workspaceHandle.name : "No") +
          ". Only use workspace tools when a folder is connected."
      },
      ...history.slice(-16)
    ];

    let response = null;
    let step = 0;

    // Limit tool cycles to prevent an endless loop.
    while (step < 8) {
      step++;

      response = await groqRequest(messages);

      if (!response) {
        throw new Error("The AI returned an empty response.");
      }

      messages.push(response);

      if (!response.tool_calls || !response.tool_calls.length) {
        break;
      }

      for (const call of response.tool_calls) {
        let result;

        try {
          const args = JSON.parse(
            call.function.arguments || "{}"
          );

          if (!workspaceHandle) {
            throw new Error(
              "No PC folder is connected. Connect a folder before asking me to access files."
            );
          }

          result = await executeTool(
            call.function.name,
            args
          );

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
        content:
          "The tool-call limit was reached. Summarize what has been completed and what remains."
      });

      response = await groqRequest(messages);
    }

    const answer =
      response?.content?.trim() ||
      "The requested operations have been processed.";

    return answer;
  }

  // --------------------------------------------------
  // CHAT + REQUEST QUEUE
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

    addMessage("user", message);

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

      if (listening) {
        window.setTimeout(() => {
          startRecognitionEngine();
        }, 350);
      }
    };
  }

  // --------------------------------------------------
  // CONNECT / DISCONNECT PC FOLDER
  // --------------------------------------------------

  async function connectWorkspace() {
    if (!window.showDirectoryPicker) {
      addMessage(
        "assistant",
        "This browser does not support the File System Access API. Try a recent desktop version of Chrome or Edge, using the HTTPS GitHub Pages address."
      );
      return;
    }

    try {
      const selectedFolder =
        await window.showDirectoryPicker({
          mode: "readwrite"
        });

      const permission =
        await selectedFolder.requestPermission({
          mode: "readwrite"
        });

      if (permission !== "granted") {
        throw new Error("Read/write permission was not granted.");
      }

      workspaceHandle = selectedFolder;

      $("workspaceStatus").textContent = "CONNECTED";
      $("workspaceDescription").textContent =
        selectedFolder.name;

      $("folderPermissionBadge").textContent =
        "READ / WRITE AUTHORIZED";

      $("folderPermissionBadge").classList.add("connected");

      $("folderDescription").textContent =
        "JARVIS can now manage files inside this folder.";

      $("folderPath").textContent =
        "Authorized folder: " + selectedFolder.name;

      $("disconnectFolder").disabled = false;

      await refreshFileTree();

      addMessage(
        "assistant",
        `Workspace connected: ${selectedFolder.name}.\n\nI can now list, read, create and edit files inside this folder. I cannot access files outside it.`
      );

    } catch (error) {
      if (error.name !== "AbortError") {
        addMessage(
          "assistant",
          "Folder connection failed: " + error.message
        );
      }
    }
  }

  function disconnectWorkspace() {
    workspaceHandle = null;
    activeFilePath = null;
    activeFileHandle = null;

    $("workspaceStatus").textContent = "DISCONNECTED";
    $("workspaceDescription").textContent =
      "No folder authorized";

    $("folderPermissionBadge").textContent =
      "NOT CONNECTED";

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

    addMessage(
      "assistant",
      "The PC workspace has been disconnected. I no longer have access to that folder."
    );
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
    const project = projects.find(item => item.id === id);
    if (!project) return;

    activeProjectId = id;
    activeFilePath = null;
    activeFileHandle = null;

    $("editorName").textContent =
      project.name + " / main.txt";

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
    activeFilePath = null;

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
      $("saveStatus").textContent =
        "NO PROJECT OPEN";
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

    const project = projects.find(
      item => item.id === activeProjectId
    );

    const filename = activeFilePath
      ? activeFilePath.split("/").pop()
      : (project?.name || "jarvis-project") + ".txt";

    const blob = new Blob(
      [content],
      { type: "text/plain;charset=utf-8" }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

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

    if (apiKey) {
      sessionStorage.setItem("jarvis_groq_key", apiKey);
    } else {
      sessionStorage.removeItem("jarvis_groq_key");
    }

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
        ". Check your key and try again.";
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

  $("saveCode").onclick = () => {
    saveActiveFile().catch(error => {
      addMessage(
        "assistant",
        "Save failed: " + error.message
      );
    });
  };

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

  $("connectFolder").onclick = connectWorkspace;

  $("disconnectFolder").onclick = disconnectWorkspace;

  $("refreshFiles").onclick = () => {
    refreshFileTree().catch(error => {
      addMessage(
        "assistant",
        "Could not refresh files: " + error.message
      );
    });
  };

  $("runPreview").onclick = async () => {
    if (activeFilePath) {
      try {
        await previewHtmlFile(activeFilePath);
      } catch (error) {
        addMessage(
          "assistant",
          "Preview failed: " + error.message
        );
      }
    } else {
      previewCurrentProject();
    }
  };

  // --------------------------------------------------
  // STARTUP
  // --------------------------------------------------

  $("tokenNote").textContent =
    apiKey ? "API KEY ACTIVE" : "NO API KEY";

  $("aiStatus").textContent =
    apiKey ? "READY" : "OFFLINE";

  $("systemPrompt").value = settings.systemPrompt;

  renderProjects();
  initSpeechRecognition();
  updateVoiceButton();

  if (!("speechSynthesis" in window)) {
    $("speakToggle").checked = false;
  }

  if (!window.showDirectoryPicker) {
    $("folderDescription").textContent =
      "This browser does not support direct folder access. Try a recent desktop Chrome or Edge browser.";
  }

})();
