export class SpatialRuntime {
  constructor({ THREE, onStatus = () => {}, onPanelAction = () => {}, getProjects = () => [] }) {
    this.T = THREE; this.onStatus = onStatus; this.onPanelAction = onPanelAction; this.getProjects = getProjects;
    this.panels = []; this.drag = null; this.session = null; this.refSpace = null; this.handStates = new Map();
    this.saved = this.readLayout(); this.projectModules = []; this.projectUpdates = []; this.makeScene();
  }
  readLayout() { try { return JSON.parse(localStorage.getItem('jarvis_spatial_layout_v2') || '{}'); } catch { return {}; } }
  saveLayout() {
    const layout = {}; this.panels.forEach(p => layout[p.userData.id] = { position: p.position.toArray(), quaternion: p.quaternion.toArray(), scale: p.scale.toArray() });
    try { localStorage.setItem('jarvis_spatial_layout_v2', JSON.stringify(layout)); } catch (e) { console.warn('Could not save spatial layout', e); }
  }
  makeScene() {
    const T = this.T; this.scene = new T.Scene(); this.scene.background = new T.Color(0x07111d);
    this.camera = new T.PerspectiveCamera(65, innerWidth / innerHeight, .01, 100); this.camera.position.set(0, 1.6, 3);
    this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true }); this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.setSize(innerWidth, innerHeight); this.renderer.xr.enabled = true;
    this.renderer.domElement.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:14;display:none;touch-action:none'; document.body.appendChild(this.renderer.domElement);
    this.scene.add(new T.HemisphereLight(0x9edfff, 0x102030, 1.8)); const light = new T.PointLight(0x2bd9ff, 16, 12); light.position.set(0, 2.5, 1); this.scene.add(light);
    const grid = new T.GridHelper(20, 60, 0x17647c, 0x103040); grid.position.y = 0; this.scene.add(grid);
    const core = new T.Mesh(new T.IcosahedronGeometry(.16, 1), new T.MeshStandardMaterial({ color: 0x39dfff, emissive: 0x087a9c, emissiveIntensity: 1.8, metalness: .6, roughness: .2 })); core.position.set(0, 1.2, -2.7); this.scene.add(core);
    this.addPanel('assistant', [0, 1.45, -1.65]); this.addPanel('projects', [-1.5, 1.35, -2.1]); this.addPanel('spatial', [1.5, 1.35, -2.1]);
    this.renderer.setAnimationLoop((t, frame) => this.frame(t, frame));
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); this.renderer.setSize(innerWidth, innerHeight); });
  }
  addPanel(type, pos = [0, 1.35, -1.8]) {
    const T = this.T, cfg = {
      assistant: ['Assistant', 'Conversation, voice and AI commands', [['Open chat', 'assistant'], ['Voice input', 'assistant']]],
      projects: ['Projects', `${this.getProjects().length} saved projects`, [['Project library', 'projects'], ['Create a project', 'assistant']]],
      spatial: ['Spatial workspace', 'Pinch and drag this panel to reposition it', [['Add assistant panel', 'assistant'], ['Add projects panel', 'projects']]],
      project: ['Project runtime', 'Immersive project workspace', [['Back to assistant', 'assistant'], ['Project library', 'projects']]]
    }[type] || ['Workspace', 'Spatial window', [['Assistant', 'assistant']]];
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 640; const ctx = canvas.getContext('2d');
    const paint = () => {
      ctx.clearRect(0, 0, 1024, 640); const g = ctx.createLinearGradient(0, 0, 1024, 640); g.addColorStop(0, 'rgba(7,24,39,.78)'); g.addColorStop(1, 'rgba(5,13,24,.68)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 640); ctx.strokeStyle = '#59dfff'; ctx.lineWidth = 3; ctx.strokeRect(2, 2, 1020, 636);
      ctx.fillStyle = '#59e6ff'; ctx.font = 'bold 25px monospace'; ctx.fillText('J.A.R.V.I.S. / SPATIAL INTERFACE', 42, 58);
      ctx.fillStyle = '#e8f8ff'; ctx.font = 'bold 52px Arial'; ctx.fillText(cfg[0], 48, 170); ctx.fillStyle = '#9ab7c9'; ctx.font = '26px Arial'; ctx.fillText(cfg[1], 50, 220);
      cfg[2].forEach((b, i) => { const x = 48 + (i % 2) * 455, y = 300 + Math.floor(i / 2) * 125; ctx.fillStyle = 'rgba(17,67,91,.78)'; ctx.fillRect(x, y, 410, 82); ctx.strokeStyle = '#53deff'; ctx.strokeRect(x, y, 410, 82); ctx.fillStyle = '#bdf6ff'; ctx.font = 'bold 26px Arial'; ctx.fillText(b[0], x + 24, y + 51); });
    }; paint(); const tex = new T.CanvasTexture(canvas); tex.colorSpace = T.SRGBColorSpace;
    const panel = new T.Mesh(new T.PlaneGeometry(1.35, .84), new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: .96, side: T.DoubleSide, depthWrite: false }));
    panel.userData = { id: `${type}-${this.panels.length}`, buttons: cfg[2], canvas, texture: tex, paint };
    const saved = this.saved[panel.userData.id]; if (saved) { panel.position.fromArray(saved.position); panel.quaternion.fromArray(saved.quaternion); panel.scale.fromArray(saved.scale); } else { panel.position.fromArray(pos); panel.lookAt(0, 1.4, 0); }
    const frame = new T.Mesh(new T.PlaneGeometry(1.39, .88), new T.MeshBasicMaterial({ color: 0x2bc8f0, wireframe: true, transparent: true, opacity: .28, depthWrite: false })); frame.position.z = -.004; panel.add(frame);
    this.scene.add(panel); this.panels.push(panel); return panel;
  }
  addProjectPanel(name, kind) { const p = this.addPanel('project', [0, 1.25, -1.5]); p.userData.title = name; p.userData.kind = kind; return p; }
  async enter(mode = 'immersive-vr') {
    if (!navigator.xr) { this.onStatus('WebXR indisponible dans ce navigateur.'); return; }
    try {
      if (!await navigator.xr.isSessionSupported(mode)) { this.onStatus(mode === 'immersive-ar' ? 'Le navigateur ne propose pas immersive-ar/passthrough. Utilise le mode VR.' : 'Mode VR non pris en charge.'); return; }
      const session = await navigator.xr.requestSession(mode, { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking', 'bounded-floor'] });
      this.session = session; this.renderer.xr.setReferenceSpaceType('local-floor'); await this.renderer.xr.setSession(session); this.refSpace = await session.requestReferenceSpace('local-floor');
      session.addEventListener('selectstart', e => { if (!e.inputSource.hand) this.selectStart(e); });
      session.addEventListener('selectend', e => { if (!e.inputSource.hand) this.selectEnd(e); }); session.addEventListener('end', () => this.ended());
      this.renderer.domElement.style.display = 'block'; document.getElementById('xrOverlay')?.classList.remove('hidden');
      if (mode === 'immersive-ar') { this.scene.background = null; this.renderer.setClearColor(0x000000, 0); this.renderer.setClearAlpha(0); }
      else { this.scene.background = new this.T.Color(0x07111d); this.renderer.setClearAlpha(1); }
      this.onStatus(mode === 'immersive-ar' ? 'Session MR active' : 'Session VR active — pince avec les doigts ou utilise les gâchettes');
    } catch (e) { console.error(e); this.onStatus('XR : ' + e.message); }
  }
  rayFromPose(pose) { const T = this.T, m = new T.Matrix4().fromArray(pose.transform.matrix); return { origin: new T.Vector3().setFromMatrixPosition(m), direction: new T.Vector3(0, 0, -1).applyQuaternion(new T.Quaternion().setFromRotationMatrix(m)).normalize() }; }
  hitTest(origin, direction) {
    const T = this.T; this.raycaster ||= new T.Raycaster(); this.raycaster.set(origin, direction);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    for (const hit of hits) { let target = hit.object; while (target && !target.userData?.onSelect && !target.userData?.buttons) target = target.parent; if (target) return { ...hit, target }; }
    return null;
  }
  pointerDown(origin, direction, input) {
    const hit = this.hitTest(origin, direction); if (!hit) return;
    const panel = hit.target || hit.object, uv = hit.uv;
    if (panel.userData.onSelect) { panel.userData.onSelect(); return; }
    if (uv && panel.userData.buttons) {
      const x = uv.x * 1024, y = (1 - uv.y) * 640;
      const idx = panel.userData.buttons.findIndex((b, i) => { const bx = 48 + (i % 2) * 455, by = 300 + Math.floor(i / 2) * 125; return x >= bx && x <= bx + 410 && y >= by && y <= by + 82; });
      if (idx >= 0) { this.onPanelAction(panel.userData.buttons[idx][1]); return; }
    }
    this.drag = { input, panel, distance: hit.distance, offset: panel.position.clone().sub(origin.clone().addScaledVector(direction, hit.distance)) };
  }
  selectStart(e) { const pose = e.frame.getPose(e.inputSource.targetRaySpace, this.refSpace); if (!pose) return; const ray = this.rayFromPose(pose); this.pointerDown(ray.origin, ray.direction, e.inputSource); }
  selectEnd(e) { if (this.drag?.input === e.inputSource) { this.drag = null; this.saveLayout(); } }
  updateHands(frame) {
    if (!this.session || !frame || !this.refSpace) return;
    for (const source of this.session.inputSources) {
      if (!source.hand) continue;
      const tip = source.hand.get('index-finger-tip'), thumb = source.hand.get('thumb-tip'), base = source.hand.get('index-finger-phalanx-proximal');
      if (!tip || !thumb || !base) continue;
      const tipPose = frame.getJointPose(tip, this.refSpace), thumbPose = frame.getJointPose(thumb, this.refSpace), basePose = frame.getJointPose(base, this.refSpace);
      if (!tipPose || !thumbPose || !basePose) continue;
      const T = this.T, tipPos = new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(tipPose.transform.matrix));
      const thumbPos = new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(thumbPose.transform.matrix));
      const basePos = new T.Vector3().setFromMatrixPosition(new T.Matrix4().fromArray(basePose.transform.matrix));
      const pinching = tipPos.distanceTo(thumbPos) < .028, state = this.handStates.get(source) || { pinching: false };
      const direction = tipPos.clone().sub(basePos).normalize();
      if (pinching && !state.pinching) this.pointerDown(tipPos.clone().addScaledVector(direction, -.025), direction, source);
      if (!pinching && state.pinching && this.drag?.input === source) { this.drag = null; this.saveLayout(); }
      if (pinching && this.drag?.input === source) {
        const p = this.drag; p.panel.position.copy(tipPos.clone().addScaledVector(direction, p.distance).add(p.offset));
      }
      state.pinching = pinching; this.handStates.set(source, state);
    }
  }
  frame(t, frame) {
    const dt = this.lastTime ? Math.min((t - this.lastTime) / 1000, .05) : 0; this.lastTime = t;
    if (frame && this.session) {
      this.updateHands(frame);
      if (this.drag && !this.drag.input?.hand && this.refSpace) { const pose = frame.getPose(this.drag.input.targetRaySpace, this.refSpace); if (pose) { const r = this.rayFromPose(pose); this.drag.panel.position.copy(r.origin.addScaledVector(r.direction, this.drag.distance).add(this.drag.offset)); } }
    }
    for (const update of this.projectUpdates) { try { update(dt, t / 1000); } catch (e) { console.error('VR project update failed', e); } }
    this.renderer.render(this.scene, this.camera);
  }
  async runProject(project) {
    if (project.kind !== 'vr' || !project.files['vr.js']) { this.onStatus('Ce projet ne contient pas de module vr.js.'); return; }
    this.onStatus('Chargement du module immersif…');
    try {
      // Generated modules run in the page context. Only run code from projects you trust.
      const url = URL.createObjectURL(new Blob([project.files['vr.js']], { type: 'text/javascript' })); const mod = await import(url);
      if (typeof mod.mount !== 'function') throw new Error('vr.js doit exporter mount({...}).');
      const addButton = (label, onClick, position = [0, 1.15, -1.35]) => {
        const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d'); x.fillStyle = 'rgba(8,42,61,.92)'; x.fillRect(0, 0, 512, 128); x.strokeStyle = '#59e6ff'; x.lineWidth = 4; x.strokeRect(2, 2, 508, 124); x.fillStyle = '#d9faff'; x.font = 'bold 34px Arial'; x.textAlign = 'center'; x.fillText(String(label).slice(0, 24), 256, 78);
        const m = new this.T.Mesh(new this.T.PlaneGeometry(.65, .16), new this.T.MeshBasicMaterial({ map: new this.T.CanvasTexture(c), transparent: true, side: this.T.DoubleSide })); m.position.set(...position); m.userData.onSelect = onClick; this.scene.add(m); return m;
      };
      const result = mod.mount({ THREE: this.T, scene: this.scene, camera: this.camera, renderer: this.renderer, addPanel: (t, p) => this.addPanel(t, p), addButton, onFrame: fn => { if (typeof fn === 'function') this.projectUpdates.push(fn); } });
      this.projectModules.push({ url, result }); this.onStatus(`Projet immersif chargé : ${project.name}`);
    } catch (e) { console.error(e); this.onStatus('Erreur projet VR : ' + e.message); }
  }
  async exit() { if (this.session) await this.session.end(); }
  ended() { this.session = null; this.drag = null; this.handStates.clear(); this.saveLayout(); this.renderer.domElement.style.display = 'none'; document.getElementById('xrOverlay')?.classList.add('hidden'); this.onStatus('Système local actif'); }
}
