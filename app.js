(() => {
"use strict";

const $ = id => document.getElementById(id);

const CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";
const WHISPER_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const WIKI_URL = "https://en.wikipedia.org/w/rest.php/v1/search/page";
const SETTINGS_KEY = "jarvis_cloud_settings_v1";

const SYSTEM = `You are J.A.R.V.I.S., a concise, intelligent, proactive personal AI assistant. Be calm, polished, analytical and naturally conversational. Default to English; follow the user's language.

You run inside a browser. You can write code, design complete web apps, games, visualizations and browser-based 3D scenes, analyze/debug code, and manage projects through the cloud workspace. You can search Wikipedia and speak through installed browser voices. You cannot run native programs, control the operating system or hardware, or access arbitrary PC files. Never claim an action succeeded unless the app confirms it.

SPECIAL RESPONSE PROTOCOL:
1) Create a project: output [code Project Name] on the first line, then ONE fenced JSON block:
{"files":{"index.html":"complete content","style.css":"complete content","app.js":"complete content"}}
Include all necessary files. For small projects, prefer a self-contained index.html. The app saves the files to the cloud workspace, hides this intermediate response, then asks you for a normal confirmation. Do not add explanations outside the JSON block.

2) Load a project: output only [read code Project Name]. The app supplies its files privately, then asks you to continue normally.

3) Search: output only [search on internet search terms]. The app searches Wikipedia and supplies results privately. Answer using those results and explain if they are insufficient.

Never show these markers in ordinary replies. Do not claim to search the entire Internet. Prefer creating project files over pasting huge code into chat.`;

let cfg = loadSettings();
let db = null;
let user = null;
let projects = [];
let active = null;
let file = null;
let history = [];
let busy = false;
let actionHistoryHandled = false;
let recognition = null;
let recorder = null;
let stream = null;
let chunks = [];
let listening = false;

function loadSettings() {
  try {
    return {
      groq: "",
      model: "openai/gpt-oss-20b",
      url: "",
      anon: "",
      ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")
    };
  } catch {
    return {groq:"",model:"openai/gpt-oss-20b",url:"",anon:""};
  }
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg));
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function setStatus(text, ok = true) {
  $("systemState").innerHTML = "<i></i> " + escapeHTML(text);
  $("systemState").style.color = ok ? "var(--green)" : "var(--red)";
}

function setSync(text) {
  $("syncStatus").textContent = text;
}

function addMessage(role, text, formatted = false) {
  const wrapper = document.createElement("div");
  wrapper.className = "message " + role;

  const speaker = document.createElement("div");
  speaker.className = "speaker";
  speaker.textContent = role === "assistant" ? "J.A.R.V.I.S." : "YOU";

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (formatted) {
    bubble.innerHTML = escapeHTML(text)
      .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  } else {
    bubble.textContent = text;
  }

  wrapper.append(speaker, bubble);
  $("chatLog").append(wrapper);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}

function setBusy(value) {
  busy = value;
  $("sendButton").disabled = value;
  $("aiState").textContent = value ? "PROCESSING" : "STANDBY";
}

/* ---------------- SUPABASE ---------------- */

function initializeDatabase() {
  db = null;
  user = null;

  if (!cfg.url || !cfg.anon || !window.supabase?.createClient) {
    renderAuth();
    return;
  }

  try {
    db = window.supabase.createClient(cfg.url, cfg.anon);

    db.auth.onAuthStateChange((_event, session) => {
      user = session?.user || null;
      renderAuth();

      if (user) loadProjects().catch(cloudError);
      else {
        projects = [];
        active = null;
        renderProjects();
        clearEditor();
      }
    });

    db.auth.getSession().then(({data,error}) => {
      if (error) throw error;

      user = data.session?.user || null;
      renderAuth();

      if (user) loadProjects().catch(cloudError);
    }).catch(cloudError);

  } catch (error) {
    $("authStatus").textContent = error.message;
    renderAuth();
  }
}

function renderAuth() {
  const connected = !!user;

  $("authPanel").classList.toggle("hidden", connected);
  $("accountPanel").classList.toggle("hidden", !connected);

  $("cloudBadge").textContent = connected ? "CLOUD SYNC ACTIVE" : "NOT CONNECTED";
  $("cloudBadge").classList.toggle("muted", !connected);
  $("accountEmail").textContent = user?.email || "";

  if (!connected) {
    $("authStatus").textContent = db
      ? "Sign in or create an account."
      : "Enter Supabase URL and public key in Settings.";

    setStatus("OFFLINE", false);
  } else {
    setStatus("CLOUD ONLINE");
  }
}

async function authenticate(mode) {
  if (!db) {
    $("settingsDialog").showModal();
    $("authStatus").textContent = "Configure Supabase first.";
    return;
  }

  const email = $("authEmail").value.trim();
  const password = $("authPassword").value;

  if (!email || password.length < 6) {
    throw Error("Enter an email and password of at least 6 characters.");
  }

  $("authStatus").textContent = "Connecting...";

  const result = mode === "signup"
    ? await db.auth.signUp({email,password})
    : await db.auth.signInWithPassword({email,password});

  if (result.error) throw result.error;

  if (mode === "signup" && !result.data.session) {
    $("authStatus").textContent =
      "Account created. Confirm your email, then sign in.";
  } else {
    user = result.data.user || result.data.session?.user;
    renderAuth();
    await loadProjects();
  }
}

async function signOut() {
  if (db) await db.auth.signOut();

  user = null;
  projects = [];
  active = null;
  file = null;
  history = [];

  renderAuth();
  renderProjects();
  clearEditor();
}

async function loadProjects() {
  if (!db || !user) return;

  setSync("Syncing...");

  const {data,error} = await db
    .from("jarvis_projects")
    .select("id,name,files,created_at,updated_at")
    .order("updated_at",{ascending:false});

  if (error) throw error;

  projects = data || [];
  renderProjects();

  setSync(`${projects.length} project(s) synced`);
  setStatus("CLOUD ONLINE");
}

function renderProjects() {
  const box = $("projectList");
  box.replaceChildren();

  if (!user) {
    box.innerHTML = '<div class="empty">Sign in to load cloud projects.</div>';
    return;
  }

  if (!projects.length) {
    box.innerHTML = '<div class="empty">No projects yet.</div>';
    return;
  }

  for (const project of projects) {
    const row = document.createElement("div");
    row.className = "project-row";

    const select = document.createElement("button");
    select.className = "project-select" +
      (active?.id === project.id ? " active" : "");
    select.textContent = project.name;
    select.onclick = () => showProject(project);

    const remove = document.createElement("button");
    remove.className = "project-mini";
    remove.textContent = "×";
    remove.title = "Delete project";
    remove.onclick = () => deleteProject(project.id);

    row.append(select,remove);
    box.append(row);
  }
}

/* ---------------- PROJECT FILES ---------------- */

function normalizeFiles(files) {
  const result = {};

  for (const [name,content] of Object.entries(files || {})) {
    const path = String(name).replace(/\\/g,"/").replace(/^\/+/,"");

    if (!path || path.split("/").some(x => x === ".." || x === ".")) {
      continue;
    }

    result[path] = String(content);
  }

  return result;
}

async function saveProject(name,files,id = null) {
  if (!db || !user) {
    throw Error("Sign in to the cloud workspace first.");
  }

  const payload = {
    user_id:user.id,
    name:String(name).trim().slice(0,80),
    files:normalizeFiles(files),
    updated_at:new Date().toISOString()
  };

  if (!payload.name) throw Error("Project name is empty.");

  const result = id
    ? await db.from("jarvis_projects")
        .update(payload).eq("id",id).select().single()
    : await db.from("jarvis_projects")
        .insert(payload).select().single();

  if (result.error) throw result.error;

  const index = projects.findIndex(p => p.id === result.data.id);

  if (index < 0) projects.unshift(result.data);
  else projects[index] = result.data;

  showProject(result.data);
  setSync("Saved to cloud ✓");

  return result.data;
}

function clearEditor() {
  $("editorTitle").textContent = "No project selected";
  $("fileSelect").innerHTML = "<option>No file</option>";
  $("fileSelect").disabled = true;
  $("codeEditor").value = "";
  $("codeEditor").disabled = true;

  ["saveFile","previewFile","downloadProject"].forEach(id => {
    $(id).disabled = true;
  });

  $("editorStatus").textContent = "Cloud files are stored in your account.";
}

function showProject(project) {
  active = project;

  const files = normalizeFiles(project.files);
  const names = Object.keys(files).sort();

  $("editorTitle").textContent = project.name;
  $("fileSelect").replaceChildren();

  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    $("fileSelect").append(option);
  }

  $("fileSelect").disabled = !names.length;
  $("codeEditor").disabled = !names.length;
  $("saveFile").disabled = !names.length;

  $("previewFile").disabled =
    !names.some(name => name.toLowerCase().endsWith(".html"));

  $("downloadProject").disabled = false;

  file = names.includes("index.html") ? "index.html" : names[0] || null;

  if (file) {
    $("fileSelect").value = file;
    $("codeEditor").value = files[file];
  } else {
    $("codeEditor").value = "";
  }

  $("editorStatus").textContent =
    `${names.length} file(s) · Cloud project`;

  renderProjects();
}

function changeFile() {
  if (!active) return;

  file = $("fileSelect").value;
  $("codeEditor").value = normalizeFiles(active.files)[file] || "";
}

async function saveCurrentFile() {
  if (!active || !file) return;

  const files = normalizeFiles(active.files);
  files[file] = $("codeEditor").value;

  await saveProject(active.name,files,active.id);

  $("editorStatus").textContent = `Saved ${file} to cloud ✓`;
}

async function deleteProject(id) {
  const project = projects.find(p => p.id === id);

  if (!project || !confirm(`Delete "${project.name}" from cloud?`)) {
    return;
  }

  const {error} = await db
    .from("jarvis_projects")
    .delete()
    .eq("id",id);

  if (error) throw error;

  projects = projects.filter(p => p.id !== id);

  if (active?.id === id) {
    active = null;
    file = null;
    clearEditor();
  }

  renderProjects();
  setSync("Deleted from cloud");
}

/* ---------------- HTML PREVIEW ---------------- */

function previewProject() {
  if (!active) return;

  const files = normalizeFiles(active.files);

  if (file) files[file] = $("codeEditor").value;

  const htmlName =
    Object.keys(files).find(x => x.toLowerCase() === "index.html") ||
    Object.keys(files).find(x => x.toLowerCase().endsWith(".html"));

  if (!htmlName) {
    $("previewStatus").textContent = "NO HTML FILE";
    return;
  }

  let html = files[htmlName];

  for (const [name,content] of Object.entries(files)) {
    if (name.endsWith(".css")) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const regex = new RegExp(
        `<link([^>]+)href=["']${escaped}["']([^>]*)>`,
        "gi"
      );

      html = html.replace(regex,`<style>${content}</style>`);
    }

    if (name.endsWith(".js")) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const regex = new RegExp(
        `<script([^>]+)src=["']${escaped}["']([^>]*)><\\/script>`,
        "gi"
      );

      html = html.replace(regex,`<script>${content}<\/script>`);
    }
  }

  $("previewFrame").srcdoc = html;
  $("previewStatus").textContent = "PREVIEW: " + htmlName;
}

/* ---------------- ZIP IMPORT / EXPORT ---------------- */

function safeFilename(name) {
  return String(name).normalize("NFKD")
    .replace(/[^\w.-]+/g,"-").slice(0,70) || "jarvis-project";
}

function downloadBlob(blob,name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url),1500);
}

async function exportProject(project = active) {
  if (!project) throw Error("Select a project first.");
  if (!window.JSZip) throw Error("ZIP library unavailable.");

  const zip = new JSZip();

  for (const [name,content] of Object.entries(normalizeFiles(project.files))) {
    zip.file(name,content);
  }

  zip.file("jarvis-project.json",JSON.stringify({
    format:"jarvis-cloud-project",
    version:1,
    name:project.name,
    exportedAt:new Date().toISOString()
  },null,2));

  const blob = await zip.generateAsync({type:"blob"});

  downloadBlob(blob,safeFilename(project.name)+".zip");
}

async function importProject(zipFile) {
  if (!user) throw Error("Sign in before importing.");
  if (!window.JSZip) throw Error("ZIP library unavailable.");

  const zip = await JSZip.loadAsync(zipFile);
  const files = {};

  for (const [name,entry] of Object.entries(zip.files)) {
    if (
      entry.dir ||
      name === "jarvis-project.json" ||
      name.startsWith("__MACOSX/") ||
      name.split("/").includes("..")
    ) continue;

    files[name] = await entry.async("string");
  }

  if (!Object.keys(files).length) {
    throw Error("No readable files in ZIP.");
  }

  let name = zipFile.name.replace(/\.zip$/i,"");

  if (zip.files["jarvis-project.json"]) {
    try {
      const metadata = JSON.parse(
        await zip.files["jarvis-project.json"].async("string")
      );
      name = metadata.name || name;
    } catch {}
  }

  await saveProject(name,files);
}

/* ---------------- AI SPECIAL COMMANDS ---------------- */

function parseCodeResponse(text) {
  const match = text.match(/^\s*\[code\s+([^\]]+)\]\s*/i);
  if (!match) return null;

  const name = match[1].trim();
  const body = text.slice(match[0].length).trim();

  const jsonMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = jsonMatch ? jsonMatch[1].trim() : body;

  let files = null;

  try {
    const parsed = JSON.parse(candidate);

    if (parsed.files && typeof parsed.files === "object") {
      files = normalizeFiles(parsed.files);
    }
  } catch {}

  if (!files) {
    const codeMatch = body.match(
      /```([a-zA-Z0-9+#.-]*)\s*([\s\S]*?)```/
    );

    if (codeMatch) {
      const extensions = {
        html:"html",css:"css",js:"js",javascript:"js",
        python:"py",py:"py",json:"json",cpp:"cpp",arduino:"ino"
      };

      const ext = extensions[codeMatch[1].toLowerCase()] || "txt";
      const filename = ext === "html" ? "index.html" : "main."+ext;

      files = {[filename]:codeMatch[2].trim()};
    }
  }

  return {name,files:files || {}};
}

function parseDirective(text) {
  let match = text.match(/^\s*\[read code\s+([^\]]+)\]\s*$/i);

  if (match) {
    return {type:"read",name:match[1].trim()};
  }

  match = text.match(/^\s*\[search on internet\s+([^\]]+)\]\s*$/i);

  if (match) {
    return {type:"search",query:match[1].trim()};
  }

  return null;
}

function findProject(name) {
  return projects.find(p => p.name.toLowerCase() === name.toLowerCase()) ||
    projects.find(p => p.name.toLowerCase().includes(name.toLowerCase()));
}

async function searchWikipedia(query) {
  const response = await fetch(
    `${WIKI_URL}?q=${encodeURIComponent(query)}&limit=6`
  );

  if (!response.ok) throw Error("Wikipedia search failed.");

  const data = await response.json();

  return (data.pages || []).map(page => ({
    title:page.title,
    description:page.description || "",
    excerpt:(page.excerpt || "").replace(/<[^>]*>/g,""),
    url:page.key
      ? "https://en.wikipedia.org/wiki/"+encodeURIComponent(page.key)
      : ""
  }));
}

/* ---------------- GROQ CHAT ---------------- */

async function askAI(messages) {
  if (!cfg.groq) {
    throw Error("Add your Groq API key in Settings.");
  }

  const response = await fetch(CHAT_URL,{
    method:"POST",
    headers:{
      Authorization:"Bearer "+cfg.groq,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:cfg.model,
      messages,
      temperature:.4,
      max_tokens:1800
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw Error(data.error?.message || "Groq error "+response.status);
  }

  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function getAIResponse(userText) {
  actionHistoryHandled = false;

  const messages = [
    {role:"system",content:SYSTEM},
    ...history.slice(-14),
    {role:"user",content:userText}
  ];

  const first = await askAI(messages);
  const project = parseCodeResponse(first);
  const command = parseDirective(first);

  if (project) {
    if (!user) {
      throw Error("Sign in to Supabase before creating an online project.");
    }

    const saved = await saveProject(project.name,project.files);

    history.push(
      {role:"user",content:userText},
      {role:"assistant",content:first},
      {
        role:"user",
        content:`INTERNAL RESULT: Project "${saved.name}" was saved successfully in the cloud. Files: ${Object.keys(saved.files || {}).join(", ")}. The intermediate code response was hidden and must not be spoken. Give a short natural confirmation. Do not repeat the marker.`
      }
    );

    actionHistoryHandled = true;

    return askAI([
      {role:"system",content:SYSTEM},
      ...history.slice(-16)
    ]);
  }

  if (command?.type === "read") {
    const found = findProject(command.name);

    history.push(
      {role:"user",content:userText},
      {role:"assistant",content:first},
      {
        role:"user",
        content:found
          ? `INTERNAL PROJECT CONTENT: ${JSON.stringify({
              name:found.name,
              files:normalizeFiles(found.files)
            })}. Use this project as context for the user's request.`
          : `INTERNAL RESULT: No cloud project named "${command.name}" was found. Tell the user honestly.`
      }
    );

    actionHistoryHandled = true;

    return askAI([
      {role:"system",content:SYSTEM},
      ...history.slice(-16)
    ]);
  }

  if (command?.type === "search") {
    let results;

    try {
      results = await searchWikipedia(command.query);
    } catch (error) {
      results = {error:error.message};
    }

    history.push(
      {role:"user",content:userText},
      {role:"assistant",content:first},
      {
        role:"user",
        content:`INTERNAL WIKIPEDIA SEARCH RESULTS for "${command.query}": ${JSON.stringify(results)}. Answer the original request using these results. State that this is a Wikipedia-focused search, not the whole web.`
      }
    );

    actionHistoryHandled = true;

    return askAI([
      {role:"system",content:SYSTEM},
      ...history.slice(-16)
    ]);
  }

  return first;
}

async function sendMessage(text) {
  const value = text.trim();

  if (!value || busy) return;

  addMessage("user",value);
  $("promptInput").value = "";
  setBusy(true);

  try {
    const response = await getAIResponse(value);

    if (actionHistoryHandled) {
      history.push({role:"assistant",content:response});
    } else {
      history.push(
        {role:"user",content:value},
        {role:"assistant",content:response}
      );
    }

    if (history.length > 28) {
      history = history.slice(-22);
    }

    addMessage("assistant",response,true);
    speak(response);

    setStatus(user ? "CLOUD ONLINE" : "AI READY");

  } catch (error) {
    console.error(error);
    addMessage("assistant","I couldn't complete that request: "+error.message);
    setStatus("ERROR",false);
  } finally {
    setBusy(false);
  }
}

/* ---------------- VOICE OUTPUT ---------------- */

function availableVoices() {
  return window.speechSynthesis?.getVoices?.() || [];
}

function chooseVoice() {
  const list = availableVoices();
  const selected = $("voiceSelect").value;

  if (selected !== "auto") {
    return list.find(v => v.name === selected) || null;
  }

  const english = list.filter(v => /^en[-_]/i.test(v.lang));
  const maleName = /daniel|george|oliver|arthur|james|ryan|guy|male|alex|fred|david|tom/i;

  return english.find(v => /en-GB/i.test(v.lang) && maleName.test(v.name)) ||
    english.find(v => maleName.test(v.name)) ||
    english.find(v => /en-GB/i.test(v.lang)) ||
    english[0] ||
    list[0] ||
    null;
}

function populateVoices() {
  const select = $("voiceSelect");
  const oldValue = select.value;

  select.innerHTML =
    '<option value="auto">Best available British male voice</option>';

  for (const voice of availableVoices()) {
    const option = document.createElement("option");
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang})`;
    select.append(option);
  }

  if ([...select.options].some(o => o.value === oldValue)) {
    select.value = oldValue;
  }
}

function speak(text) {
  if (!$("speakToggle").checked || !window.speechSynthesis) return;

  speechSynthesis.cancel();

  const clean = String(text)
    .replace(/```[\s\S]*?```/g,"Code omitted.")
    .replace(/`([^`]+)`/g,"$1")
    .slice(0,3000);

  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = chooseVoice();

  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "en-GB";
  }

  utterance.rate = .91;
  utterance.pitch = .78;
  utterance.volume = 1;

  speechSynthesis.speak(utterance);
}

/* ---------------- MICROPHONE ---------------- */

function releaseMicrophone() {
  if (stream) {
    stream.getTracks().forEach(track => track.stop());
    stream = null;
  }

  recorder = null;
  listening = false;
  $("micButton").classList.remove("active");
}

async function transcribeAudio(blob) {
  if (blob.size < 1200) {
    $("micStatus").textContent = "No speech detected.";
    return;
  }

  if (!cfg.groq) {
    $("micStatus").textContent = "Add Groq key for Whisper.";
    return;
  }

  $("micStatus").textContent = "Transcribing...";

  try {
    const extension = blob.type.includes("ogg")
      ? "ogg"
      : blob.type.includes("mp4")
        ? "mp4"
        : "webm";

    const form = new FormData();

    form.append("file",blob,"voice."+extension);
    form.append("model","whisper-large-v3-turbo");
    form.append("response_format","json");

    const response = await fetch(WHISPER_URL,{
      method:"POST",
      headers:{Authorization:"Bearer "+cfg.groq},
      body:form
    });

    const data = await response.json();

    if (!response.ok) {
      throw Error(data.error?.message || "Whisper "+response.status);
    }

    if (data.text?.trim()) {
      sendMessage(data.text.trim());
    } else {
      $("micStatus").textContent = "No speech recognized.";
    }

  } catch (error) {
    $("micStatus").textContent = "Transcription failed: "+error.message;
  }
}

async function startMicrophone() {
  if (listening) {
    stopMicrophone();
    return;
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (SpeechRecognition) {
    try {
      recognition = new SpeechRecognition();
      recognition.lang = "en-GB";
      recognition.continuous = false;
      recognition.interimResults = false;

      recognition.onresult = event => {
        const transcript = event.results?.[0]?.[0]?.transcript;
        if (transcript) sendMessage(transcript);
      };

      recognition.onerror = event => {
        $("micStatus").textContent =
          "Speech recognition: "+event.error;
      };

      recognition.onend = () => {
        listening = false;
        $("micButton").classList.remove("active");
      };

      listening = true;
      $("micButton").classList.add("active");
      $("micStatus").textContent = "Listening...";
      recognition.start();
      return;

    } catch (error) {
      console.warn(error);
    }
  }

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    $("micStatus").textContent = "Microphone unsupported in this browser.";
    return;
  }

  if (!cfg.groq) {
    $("micStatus").textContent = "Add Groq key to use Whisper.";
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio:{
        echoCancellation:true,
        noiseSuppression:true,
        autoGainControl:true
      }
    });

    const mimeTypes = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4"
    ];

    const mime = mimeTypes.find(type =>
      MediaRecorder.isTypeSupported(type)
    ) || "";

    recorder = new MediaRecorder(
      stream,
      mime ? {mimeType:mime} : undefined
    );

    chunks = [];

    recorder.ondataavailable = event => {
      if (event.data?.size) chunks.push(event.data);
    };

    recorder.onstop = async () => {
      const blob = new Blob(chunks,{
        type:recorder?.mimeType || mime || "audio/webm"
      });

      await transcribeAudio(blob);
      releaseMicrophone();
    };

    recorder.start();

    listening = true;
    $("micButton").classList.add("active");
    $("micStatus").textContent = "Recording — press microphone to stop.";

  } catch (error) {
    $("micStatus").textContent = "Microphone error: "+error.message;
    releaseMicrophone();
  }
}

function stopMicrophone() {
  if (recognition) {
    try {
      recognition.stop();
    } catch {}

    recognition = null;
  }

  if (recorder?.state === "recording") {
    recorder.stop();
  } else {
    releaseMicrophone();
  }

  listening = false;
  $("micButton").classList.remove("active");
}

/* ---------------- SETTINGS AND EVENTS ---------------- */

function openSettings() {
  $("groqKey").value = cfg.groq;
  $("modelSelect").value = cfg.model;
  $("supabaseUrl").value = cfg.url;
  $("supabaseKey").value = cfg.anon;

  $("settingsDialog").showModal();
}

function saveSettings() {
  cfg.groq = $("groqKey").value.trim();
  cfg.model = $("modelSelect").value;
  cfg.url = $("supabaseUrl").value.trim().replace(/\/+$/,"");
  cfg.anon = $("supabaseKey").value.trim();

  saveSettingsToStorage();
  $("settingsDialog").close();
  initializeDatabase();
}

function saveSettingsToStorage() {
  saveSettings();
}

function bindEvents() {
  $("settingsOpen").onclick = openSettings;
  $("saveSettings").onclick = saveSettings;

  $("signIn").onclick = () =>
    authenticate("signin").catch(error => {
      $("authStatus").textContent = error.message;
    });

  $("signUp").onclick = () =>
    authenticate("signup").catch(error => {
      $("authStatus").textContent = error.message;
    });

  $("signOut").onclick = () => signOut().catch(cloudError);

  $("chatForm").onsubmit = event => {
    event.preventDefault();
    sendMessage($("promptInput").value);
  };

  $("promptInput").onkeydown = event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("chatForm").requestSubmit();
    }
  };

  $("micButton").onclick = startMicrophone;
  $("fileSelect").onchange = changeFile;

  $("saveFile").onclick = () =>
    saveCurrentFile().catch(cloudError);

  $("previewFile").onclick = previewProject;

  $("downloadProject").onclick = () =>
    exportProject().catch(error => alert(error.message));

  $("openPreview").onclick = () => {
    const frame = $("previewFrame");
    const tab = window.open("about:blank","_blank");

    if (tab) {
      tab.document.open();
      tab.document.write(frame.srcdoc);
      tab.document.close();
    }
  };

  $("newProject").onclick = () => {
    if (!user) {
      $("projectDialogStatus").textContent = "Sign in first.";
    }

    $("projectName").value = "";
    $("projectDialog").showModal();
  };

  $("createProject").onclick = async () => {
    try {
      const name = $("projectName").value.trim();

      if (!name) throw Error("Enter a project name.");

      await saveProject(name,{
        "README.txt":`# ${name}\n\nCreated in JARVIS Cloud Workspace.\n`
      });

      $("projectDialog").close();

    } catch (error) {
      $("projectDialogStatus").textContent = error.message;
    }
  };

  $("importProject").onclick = () => $("zipInput").click();

  $("zipInput").onchange = async event => {
    const zipFile = event.target.files?.[0];
    if (!zipFile) return;

    try {
      await importProject(zipFile);
      setSync("ZIP imported to cloud ✓");
    } catch (error) {
      alert("Import failed: "+error.message);
    } finally {
      event.target.value = "";
    }
  };

  $("testVoice").onclick = () =>
    speak("Good evening. All systems are operational. How may I assist you?");
}

function cloudError(error) {
  console.error(error);
  setSync("Cloud error: "+(error.message || error));
}

function initialize() {
  bindEvents();
  populateVoices();

  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }

  initializeDatabase();
  clearEditor();

  if (!cfg.groq) {
    addMessage(
      "assistant",
      "Open Settings and add your Groq API key. Then sign in to Supabase to enable your online workspace."
    );
  }
}

initialize();

})();
