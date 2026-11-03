import './style.css';
import * as THREE from 'three';
import { createClient } from '@supabase/supabase-js';
import { SpatialRuntime } from './vr.js';

const $ = id => document.getElementById(id);

const SETTINGS_KEY = 'jarvis_spatial_settings_v1';
const LOCAL_PROJECTS_KEY = 'jarvis_spatial_projects_v1';

function readLocal(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

let settings = {
  supabaseUrl: '',
  supabaseKey: '',
  voice: 'daniel',
  premiumVoice: false,
  ...readLocal(SETTINGS_KEY, {})
};

let supabase = null;
let session = null;
let projects = [];
let activeProject = null;
let spatial = null;

let conversationId = null;
let chatHistory = [
  { role: 'assistant', content: 'Systems online. How may I assist you?' }
];

let cloudReady = false;

function setStatus(status) {
  const element = $('connectionState');
  if (element) element.textContent = status;
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function localProjects() {
  return readLocal(LOCAL_PROJECTS_KEY, []);
}

function cacheProjects() {
  localStorage.setItem(
    LOCAL_PROJECTS_KEY,
    JSON.stringify(projects)
  );
}

/* -------------------------------------------------------
   SUPABASE CONNECTION
------------------------------------------------------- */

function connectSupabase() {
  supabase = null;
  session = null;
  cloudReady = false;

  if (!settings.supabaseUrl || !settings.supabaseKey) {
    setStatus('Configuration Supabase requise');
    projects = localProjects();
    renderProjects();
    return;
  }

  try {
    supabase = createClient(
      settings.supabaseUrl,
      settings.supabaseKey
    );

    supabase.auth.getSession().then(async ({ data, error }) => {
      if (error) {
        setStatus('Erreur de connexion');
        console.error(error);
        return;
      }

      session = data.session;

      if (session) {
        await loadCloudData();
      } else {
        setStatus('Connexion requise');
        projects = localProjects();
        renderProjects();
      }
    });

    supabase.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession;

      if (session) {
        await loadCloudData();
      } else {
        cloudReady = false;
        conversationId = null;
        chatHistory = [
          {
            role: 'assistant',
            content: 'Systems online. How may I assist you?'
          }
        ];

        projects = localProjects();
        renderProjects();
        setStatus('Déconnecté');
      }
    });

  } catch (error) {
    console.error(error);
    setStatus('Configuration invalide');
  }
}

async function loadCloudData() {
  if (!supabase || !session) return;

  cloudReady = false;
  setStatus('Synchronisation...');

  try {
    await loadProjects();
    await loadUserSettings();
    await loadConversation();

    cloudReady = true;
    setStatus('Cloud synchronisé');
  } catch (error) {
    console.error('Cloud synchronization error:', error);
    setStatus('Erreur de synchronisation');
    addMessage(
      'assistant',
      'Cloud synchronization failed: ' + error.message
    );
  }
}

/* -------------------------------------------------------
   SETTINGS
------------------------------------------------------- */

async function saveSettings() {
  const oldUrl = settings.supabaseUrl;
  const oldKey = settings.supabaseKey;

  settings.supabaseUrl = $('supabaseUrl').value.trim().replace(/\/$/, '');
  settings.supabaseKey = $('supabaseKey').value.trim();
  settings.premiumVoice = $('premiumVoice').checked;
  settings.voice = $('voiceChoice').value;

  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify(settings)
  );

  $('settingsStatus').textContent = 'Paramètres enregistrés localement.';

  if (
    oldUrl !== settings.supabaseUrl ||
    oldKey !== settings.supabaseKey
  ) {
    connectSupabase();
  } else if (session && supabase) {
    try {
      await saveUserSettings();
      $('settingsStatus').textContent =
        'Paramètres enregistrés et synchronisés dans le cloud.';
    } catch (error) {
      $('settingsStatus').textContent =
        'Erreur de sauvegarde cloud : ' + error.message;
    }
  }
}

async function saveUserSettings() {
  if (!supabase || !session) {
    throw new Error('Aucune session cloud active.');
  }

  const preferences = {
    voice: settings.voice,
    premiumVoice: settings.premiumVoice
  };

  const { error } = await supabase
    .from('jarvis_user_settings')
    .upsert({
      user_id: session.user.id,
      settings: preferences,
      updated_at: new Date().toISOString()
    });

  if (error) throw error;
}

async function loadUserSettings() {
  if (!supabase || !session) return;

  const { data, error } = await supabase
    .from('jarvis_user_settings')
    .select('settings')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error) throw error;

  if (data?.settings) {
    settings.voice = data.settings.voice || 'daniel';
    settings.premiumVoice = !!data.settings.premiumVoice;

    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify(settings)
    );
  }
}

/* -------------------------------------------------------
   AUTHENTICATION
------------------------------------------------------- */

async function auth(mode) {
  if (!supabase) {
    $('settingsStatus').textContent =
      'Enregistre d’abord les informations Supabase.';
    return;
  }

  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;

  if (!email || !password) {
    $('settingsStatus').textContent =
      'Renseigne e-mail et mot de passe.';
    return;
  }

  const result = mode === 'signup'
    ? await supabase.auth.signUp({ email, password })
    : await supabase.auth.signInWithPassword({ email, password });

  if (result.error) {
    $('settingsStatus').textContent = result.error.message;
    return;
  }

  if (mode === 'signup' && !result.data.session) {
    $('settingsStatus').textContent =
      'Compte créé. Vérifie ton e-mail si nécessaire.';
    return;
  }

  $('settingsStatus').textContent = 'Connexion réussie.';

  if (result.data.session) {
    session = result.data.session;
    await loadCloudData();
  }
}

/* -------------------------------------------------------
   PROJECTS
------------------------------------------------------- */

async function loadProjects() {
  if (!supabase || !session) {
    projects = localProjects();
    renderProjects();
    return;
  }

  const { data, error } = await supabase
    .from('jarvis_projects')
    .select('*')
    .order('updated_at', { ascending: false });

  if (error) throw error;

  projects = (data || []).map(row => ({
    id: row.id,
    name: row.name,
    kind: row.kind || 'web',
    files: row.files || {},
    updatedAt: row.updated_at
  }));

  cacheProjects();
  renderProjects();
}

async function saveProject(project) {
  if (!supabase || !session) {
    throw new Error(
      'Connecte-toi à Supabase pour sauvegarder un projet en ligne.'
    );
  }

  project.updatedAt = new Date().toISOString();

  const { error } = await supabase
    .from('jarvis_projects')
    .upsert({
      id: project.id,
      user_id: session.user.id,
      name: project.name,
      kind: project.kind,
      files: project.files,
      updated_at: project.updatedAt
    });

  if (error) {
    throw new Error('Sauvegarde du projet impossible : ' + error.message);
  }

  const index = projects.findIndex(p => p.id === project.id);

  if (index >= 0) {
    projects[index] = project;
  } else {
    projects.unshift(project);
  }

  cacheProjects();
  renderProjects();
}

function renderProjects() {
  const grid = $('projectGrid');
  if (!grid) return;

  if (!projects.length) {
    grid.innerHTML =
      '<div class="empty-state">Aucun projet pour le moment.</div>';
    return;
  }

  grid.innerHTML = projects.map(project => `
    <article class="project-card">
      <span class="eyebrow">
        ${project.kind === 'vr' ? 'IMMERSIVE PROJECT' : 'WEB PROJECT'}
      </span>
      <h4>${escapeHtml(project.name)}</h4>
      <p>${new Date(project.updatedAt || Date.now()).toLocaleDateString()}</p>
      <button class="tiny" data-open="${escapeHtml(project.id)}">Ouvrir</button>
      <button class="tiny" data-export="${escapeHtml(project.id)}">Exporter</button>
    </article>
  `).join('');

  grid.querySelectorAll('[data-open]').forEach(button => {
    button.onclick = () => openProject(button.dataset.open);
  });

  grid.querySelectorAll('[data-export]').forEach(button => {
    button.onclick = () => exportProject(button.dataset.export);
  });
}

function openProject(id) {
  activeProject = projects.find(project => project.id === id);
  if (!activeProject) return;

  showView('workspace');

  $('editorTitle').textContent = activeProject.name;
  $('editorContent').innerHTML =
    '<pre class="code-preview"></pre>';

  $('editorContent').querySelector('pre').textContent =
    activeProject.files['index.html'] ||
    activeProject.files['vr.js'] ||
    JSON.stringify(activeProject.files, null, 2);

  if (spatial) {
    spatial.addProjectPanel(
      activeProject.name,
      activeProject.kind
    );
  }
}

function exportProject(id) {
  const project = projects.find(p => p.id === id);
  if (!project) return;

  const blob = new Blob(
    [JSON.stringify(project, null, 2)],
    { type: 'application/json' }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download =
    project.name.replace(/[^\w-]/g, '_') + '.jarvis.json';

  link.click();
  URL.revokeObjectURL(url);
}

/* -------------------------------------------------------
   PROJECT PREVIEW
------------------------------------------------------- */

function previewProject() {
  if (!activeProject) return;

  if (activeProject.kind === 'vr') {
    spatial?.runProject(activeProject);
    return;
  }

  const files = activeProject.files;

  const html = files['index.html'] || '<h1>index.html missing</h1>';
  const css = files['style.css'] || '';
  const js = files['app.js'] || '';

  const documentContent = html
    .replace(
      '</head>',
      `<style>${css.replace(/<\/style/gi, '<\\/style')}</style></head>`
    )
    .replace(
      '</body>',
      `<script>${js.replace(/<\/script/gi, '<\\/script')}<\/script></body>`
    );

  $('previewName').textContent = activeProject.name;
  $('projectFrame').srcdoc = documentContent;
  $('previewModal').classList.remove('hidden');
}

/* -------------------------------------------------------
   CONVERSATIONS
------------------------------------------------------- */

async function loadConversation() {
  if (!supabase || !session) return;

  const { data, error } = await supabase
    .from('jarvis_conversations')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;

  if (data) {
    conversationId = data.id;
    chatHistory = Array.isArray(data.messages)
      ? data.messages
      : [];

    if (!chatHistory.length) {
      chatHistory = [
        {
          role: 'assistant',
          content: 'Systems online. How may I assist you?'
        }
      ];
    }

    renderChatHistory();
  } else {
    conversationId = crypto.randomUUID();

    chatHistory = [
      {
        role: 'assistant',
        content: 'Systems online. How may I assist you?'
      }
    ];

    await saveConversation();
  }
}

async function saveConversation() {
  if (!supabase || !session) {
    throw new Error('Aucune session cloud active.');
  }

  if (!conversationId) {
    conversationId = crypto.randomUUID();
  }

  const title = (
    chatHistory.find(message => message.role === 'user')?.content ||
    'New conversation'
  ).slice(0, 80);

  const { error } = await supabase
    .from('jarvis_conversations')
    .upsert({
      id: conversationId,
      user_id: session.user.id,
      title,
      messages: chatHistory,
      updated_at: new Date().toISOString()
    });

  if (error) {
    throw new Error('Sauvegarde de la conversation impossible : ' + error.message);
  }
}

function renderChatHistory() {
  const container = $('chatMessages');
  if (!container) return;

  container.innerHTML = '';

  chatHistory.forEach(message => {
    if (message.role === 'user' || message.role === 'assistant') {
      addMessage(message.role, message.content);
    }
  });
}

/* -------------------------------------------------------
   CHAT DISPLAY
------------------------------------------------------- */

function addMessage(role, text) {
  const node = document.createElement('div');

  node.className = `message ${role}`;

  node.innerHTML = `
    <span class="avatar">${role === 'assistant' ? 'J' : 'YOU'}</span>
    <div>
      <b>${role === 'assistant' ? 'J.A.R.V.I.S.' : 'YOU'}</b>
      <p></p>
    </div>
  `;

  node.querySelector('p').textContent = text;

  $('chatMessages').append(node);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
}

function showView(name) {
  ['home', 'projects', 'workspace'].forEach(view => {
    $(`${view}View`).classList.toggle('hidden', view !== name);
  });

  document.querySelectorAll('.nav[data-view]').forEach(button => {
    button.classList.toggle('active', button.dataset.view === name);
  });

  $('pageTitle').textContent = {
    home: 'Bonjour.',
    projects: 'Mes projets.',
    workspace: 'Workspace.'
  }[name];
}

/* -------------------------------------------------------
   AI CONNECTION
------------------------------------------------------- */

async function callJarvis(messages, action = 'chat', extra = {}) {
  if (!supabase || !session) {
    throw new Error(
      'Connecte-toi à Supabase dans Configuration avant d’utiliser l’IA.'
    );
  }

  const response = await fetch(
    `${settings.supabaseUrl}/functions/v1/jarvis`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': settings.supabaseKey
      },
      body: JSON.stringify({
        action,
        messages,
        ...extra
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Service IA (${response.status}) : ${(await response.text()).slice(0, 300)}`
    );
  }

  return action === 'speech'
    ? response.blob()
    : response.json();
}

/* -------------------------------------------------------
   JARVIS INSTRUCTIONS
------------------------------------------------------- */

const systemPrompt = `You are J.A.R.V.I.S., a concise, professional spatial AI assistant.

Keep spoken replies short. Never claim an action succeeded if it did not.

PROJECT CREATION RULES:
When the user asks you to create, build, or modify a project, return exactly one valid project block:

<JARVIS_PROJECT>
{"name":"Project name","kind":"web","files":{"index.html":"...","style.css":"...","app.js":"..."}}
</JARVIS_PROJECT>

STRICT FORMATTING:
- Always include BOTH opening and closing JARVIS_PROJECT tags.
- Never escape the tags with backslashes.
- Never put the JSON inside Markdown code fences.
- Output valid JSON, not JavaScript.
- Escape newlines inside JSON strings as \\n.
- Escape double quotes inside JSON strings as \\".
- Do not add explanations before or after the project block.
- Do not omit required files.
- For web projects provide index.html, style.css and app.js.
- For immersive projects use kind "vr" and provide vr.js.
- Never claim a project was saved. The application handles saving.

VR PROJECT RULES:
A vr.js file must export function mount({THREE,scene,camera,renderer,addPanel,addButton,onFrame}).
Do not import three.
Use addButton(label,onSelect,position) for selectable spatial buttons.
Use onFrame(fn) to register animation updates.

Do not use tool calls.`;

/* -------------------------------------------------------
   PROJECT BLOCK PARSER
------------------------------------------------------- */

function extractProject(response) {
  const normalized = response
    .replace(/\\(?=<\/?JARVIS_PROJECT>)/gi, '')
    .replace(
      /\\(?=<\/?(?:!DOCTYPE|html|head|body|meta|title|link|script|style|canvas)\b)/gi,
      ''
    );

  const match = normalized.match(
    /<JARVIS_PROJECT>\s*([\s\S]*?)(?:\s*<\/JARVIS_PROJECT>\s*|$)/i
  );

  if (!match) return null;

  const jsonText = match[1].replace(
    /\\(?!["\\/bfnrtu])/g,
    ''
  );

  const project = JSON.parse(jsonText);

  if (!project.files || typeof project.files !== 'object') {
    throw new Error('Le projet généré ne contient pas de fichiers valides.');
  }

  if (project.kind !== 'vr' && !project.files['index.html']) {
    throw new Error('Le projet web ne contient pas index.html.');
  }

  return {
    id: crypto.randomUUID(),
    name: project.name || 'New Project',
    kind: project.kind === 'vr' ? 'vr' : 'web',
    files: project.files,
    updatedAt: new Date().toISOString()
  };
}

/* -------------------------------------------------------
   CHAT
------------------------------------------------------- */

async function sendMessage() {
  const input = $('chatInput');
  const text = input.value.trim();

  if (!text) return;

  input.value = '';

  addMessage('user', text);
  chatHistory.push({
    role: 'user',
    content: text
  });

  $('sendMessage').disabled = true;

  try {
    let response;

    if (/^\[search on internet (.+)\]$/i.test(text)) {
      const query = text.match(
        /^\[search on internet (.+)\]$/i
      )[1];

      const result = await fetch(
        `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=5`
      );

      const data = await result.json();

      response = (data.pages || [])
        .map(page => `${page.title}: ${page.description || ''}`)
        .join('\n') || 'No useful results found.';

    } else if (/^\[read code (.+)\]$/i.test(text)) {
      const name = text.match(
        /^\[read code (.+)\]$/i
      )[1];

      const project = projects.find(
        item => item.name.toLowerCase() === name.toLowerCase()
      );

      if (project) {
        chatHistory.push({
          role: 'system',
          content: `Project source loaded: ${project.name}\n${JSON.stringify(project.files)}`
        });

        response = `Loaded ${project.name} into my context.`;
      } else {
        response = `I couldn't find a project named ${name}.`;
      }

    } else {
      const result = await callJarvis([
        { role: 'system', content: systemPrompt },
        ...chatHistory.slice(-10)
      ]);

      response =
        result.choices?.[0]?.message?.content ||
        'No response received.';
    }

    let project = null;

    if (response.includes('<JARVIS_PROJECT>') ||
        response.includes('\\<JARVIS_PROJECT>')) {
      project = extractProject(response);
    }

    if (project) {
      await saveProject(project);

      activeProject = project;
      openProject(project.id);

      response =
        `Project "${project.name}" created and saved to your cloud account.`;
    }

    chatHistory.push({
      role: 'assistant',
      content: response
    });

    addMessage('assistant', response);

    try {
      await saveConversation();
    } catch (error) {
      addMessage(
        'assistant',
        '⚠️ Conversation not synchronized: ' + error.message
      );
    }

    if (settings.premiumVoice) {
      await speakPremium(response);
    } else {
      speakBrowser(response);
    }

  } catch (error) {
    console.error('JARVIS error:', error);

    addMessage(
      'assistant',
      `I couldn't complete that request: ${error.message}`
    );

  } finally {
    $('sendMessage').disabled = false;
  }
}

/* -------------------------------------------------------
   VOICE
------------------------------------------------------- */

function speakBrowser(text) {
  if (!('speechSynthesis' in window)) return;

  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(
    text.replace(/<[^>]*>/g, '')
  );

  utterance.lang = 'en-GB';
  utterance.rate = 0.96;
  utterance.pitch = 0.88;

  const voices = speechSynthesis.getVoices();

  utterance.voice =
    voices.find(voice =>
      /daniel|george|oliver|arthur|ryan|guy/i.test(voice.name)
    ) ||
    voices.find(voice => voice.lang === 'en-GB') ||
    null;

  speechSynthesis.speak(utterance);
}

async function speakPremium(text) {
  const sentences = (
    text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  )
    .map(sentence => sentence.trim())
    .filter(Boolean);

  try {
    for (const sentence of sentences) {
      for (let i = 0; i < sentence.length; i += 185) {
        const blob = await callJarvis(
          [],
          'speech',
          {
            text: sentence.slice(i, i + 185),
            voice: settings.voice
          }
        );

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        await new Promise((resolve, reject) => {
          audio.onended = resolve;
          audio.onerror = reject;
          audio.play().catch(reject);
        });

        URL.revokeObjectURL(url);
      }
    }
  } catch (error) {
    console.warn('Premium voice failed:', error);
    speakBrowser(text);
  }
}

function startVoice() {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    addMessage(
      'assistant',
      'Speech recognition is unavailable in this browser. Use the text field.'
    );
    return;
  }

  const recognition = new SpeechRecognition();

  recognition.lang = 'en-GB';
  recognition.interimResults = false;

  $('voiceButton').classList.add('recording');

  recognition.onresult = event => {
    $('chatInput').value =
      event.results[0][0].transcript;

    sendMessage();
  };

  recognition.onerror = recognition.onend = () => {
    $('voiceButton').classList.remove('recording');
  };

  recognition.start();
}

/* -------------------------------------------------------
   SETTINGS MODAL
------------------------------------------------------- */

function openSettings() {
  $('supabaseUrl').value = settings.supabaseUrl;
  $('supabaseKey').value = settings.supabaseKey;
  $('premiumVoice').checked = !!settings.premiumVoice;
  $('voiceChoice').value = settings.voice || 'daniel';

  $('settingsModal').classList.remove('hidden');
}

/* -------------------------------------------------------
   INTERFACE EVENTS
------------------------------------------------------- */

function wire() {
  document.querySelectorAll('.nav[data-view]').forEach(button => {
    button.onclick = () => showView(button.dataset.view);
  });

  $('openSettings').onclick =
    $('openSettingsTop').onclick = openSettings;

  $('closeSettings').onclick = () => {
    $('settingsModal').classList.add('hidden');
  };

  $('saveSettings').onclick = saveSettings;

  $('signIn').onclick = () => auth('signin');
  $('signUp').onclick = () => auth('signup');

  $('startChat').onclick = () => showView('workspace');

  $('sendMessage').onclick = sendMessage;

  $('chatInput').onkeydown = event => {
    if (event.key === 'Enter') sendMessage();
  };

  $('voiceButton').onclick = startVoice;

  $('newProject').onclick = () => {
    showView('workspace');
    $('chatInput').value =
      'Create an interactive project named New Project';
    $('chatInput').focus();
  };

  $('exportProject').onclick = () => {
    if (activeProject) exportProject(activeProject.id);
  };

  $('runProject').onclick = previewProject;

  $('closePreview').onclick = () => {
    $('previewModal').classList.add('hidden');
  };

  document.querySelectorAll('[data-open-panel]').forEach(button => {
    button.onclick = () => {
      showView('workspace');
      spatial?.addPanel(button.dataset.openPanel);
    };
  });

  $('enterVR').onclick = () => {
    spatial?.enter('immersive-vr');
  };

  $('enterMR').onclick = () => {
    spatial?.enter('immersive-ar');
  };

  $('exitXR').onclick = () => {
    spatial?.exit();
  };
}

/* -------------------------------------------------------
   START
------------------------------------------------------- */

function boot() {
  wire();
  connectSupabase();

  spatial = new SpatialRuntime({
    THREE,
    onStatus: setStatus,

    onPanelAction: action => {
      if (action === 'assistant') {
        showView('workspace');
      }

      if (action === 'projects') {
        showView('projects');
      }

      if (action === 'spatial') {
        spatial.addPanel('spatial');
      }
    },

    getProjects: () => projects
  });
}

boot();
