// Immersive VR / passthrough view. Loaded only in a WebXR-capable browser (Meta Quest Browser).
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';

const FONT = 'Plex, system-ui, sans-serif';
const MONO = 'PlexMono, ui-monospace, monospace';
const LIME = '#d4ff3f';
const isRTL = s => /[֐-ࣿ]/.test(s);
const STATE_COLOR = { idle: 0xc9ccd2, listening: 0xd4ff3f, hearing: 0xd4ff3f, thinking: 0xffb02e, looking: 0xffb02e, speaking: 0xffffff };

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function wrapText(g, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const tt = line ? line + ' ' + word : word;
      if (g.measureText(tt).width > maxW && line) { out.push(line); line = word; } else line = tt;
    }
    out.push(line);
  }
  return out;
}

export async function createXR(core) {
  const { t, S } = core;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.xr.setFoveation(0.4);
  renderer.domElement.className = 'xr';
  renderer.domElement.style.display = 'none';
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);
  const aniso = renderer.capabilities.getMaxAnisotropy();

  const canvasPlane = (w, h, ppm) => {
    const c = document.createElement('canvas'); c.width = Math.round(w * ppm); c.height = Math.round(h * ppm);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = aniso;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    return { c, g: c.getContext('2d'), tex, mesh };
  };

  // environment (VR only): dark void + floor grid
  const env = new THREE.Group(); scene.add(env);
  env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 32, 16), new THREE.MeshBasicMaterial({ color: 0x07080a, side: THREE.BackSide })));
  const grid = new THREE.GridHelper(60, 60, 0x2a2f36, 0x15181c); env.add(grid);

  const ui = new THREE.Group(); scene.add(ui);
  const PW = 1.1, PH = 0.95;
  const panel = canvasPlane(PW, PH, 1400); ui.add(panel.mesh);

  // camera preview + detection overlay
  const camTex = new THREE.VideoTexture(core.camVideo); camTex.colorSpace = THREE.SRGBColorSpace;
  const camPanel = new THREE.Group();
  const camMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshBasicMaterial({ map: camTex }));
  const hudLayer = canvasPlane(0.56, 0.42, 1400); hudLayer.mesh.position.z = 0.002;
  camPanel.add(camMesh, hudLayer.mesh);
  camPanel.position.set(-0.9, 0.12, 0.16); camPanel.rotation.y = 0.45; camPanel.visible = false;
  ui.add(camPanel);

  // state orb
  const orbMat = new THREE.MeshBasicMaterial({ color: 0xc9ccd2, transparent: true, opacity: 0.95 });
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 32, 16), orbMat);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xc9ccd2, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.045, 0.049, 64), ringMat);
  const orbGroup = new THREE.Group(); orbGroup.add(orb, ring); orbGroup.position.set(0, PH / 2 + 0.08, 0.01); ui.add(orbGroup);

  // buttons
  const buttons = [];
  const BH = 0.085;
  const mk = (id, w, onPress, opts = {}) => {
    const p = canvasPlane(w, BH, 1400);
    const b = { id, ...p, w, onPress, hover: false, active: false, label: '', hoverT: 0, ...opts };
    b.draw = () => {
      const { g, c, tex } = b; g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = b.active ? LIME : b.hover ? '#2a2f36' : 'rgba(23,26,30,.96)';
      roundRect(g, 3, 3, c.width - 6, c.height - 6, 26); g.fill();
      g.strokeStyle = b.hover ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.1)'; g.lineWidth = 3; g.stroke();
      g.fillStyle = b.active ? '#0e1200' : '#eceef1'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.direction = S.lang === 'ar' ? 'rtl' : 'ltr';
      let size = 42; g.font = `600 ${size}px ${FONT}`;
      while (g.measureText(b.label).width > c.width - 40 && size > 22) { size -= 2; g.font = `600 ${size}px ${FONT}`; }
      g.fillText(b.label, c.width / 2, c.height / 2 + 3);
      tex.needsUpdate = true;
    };
    p.mesh.userData.button = b; ui.add(p.mesh); buttons.push(b);
    return b;
  };
  let needsRecenter = false;
  const btn = {
    live: mk('live', 0.2, () => { core.ensureAudioCtx(); core.setLive(!core.live); }),
    mic: mk('mic', 0.26, null, { hold: true }),
    cam: mk('cam', 0.18, core.camToggle),
    look: mk('look', 0.2, () => core.ask('', { forceImage: true })),
    stop: mk('stop', 0.16, () => core.stopAll()),
    clear: mk('clear', 0.2, core.clearChat),
    lang: mk('lang', 0.12, () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; core.save(); core.applyLang(); }),
    provider: mk('provider', 0.2, core.cycleProvider),
    recenter: mk('recenter', 0.16, () => { needsRecenter = true; }),
    exit: mk('exit', 0.14, () => renderer.xr.getSession()?.end()),
  };
  const rows = [['live', 'mic', 'cam', 'look', 'stop'], ['clear', 'lang', 'provider', 'recenter', 'exit']];
  let labelSig = '';
  function relabel() {
    const sig = [S.lang, core.live, core.camOn, core.recording, S.provider].join('|');
    if (sig === labelSig) return; labelSig = sig;
    btn.live.label = t('live'); btn.live.active = core.live;
    btn.mic.label = t('talk'); btn.mic.active = core.recording;
    btn.cam.label = t('cam'); btn.cam.active = core.camOn;
    btn.look.label = t('look'); btn.stop.label = t('stop'); btn.clear.label = t('clear');
    btn.lang.label = S.lang === 'ar' ? 'EN' : 'ع';
    btn.provider.label = core.SHORT[S.provider];
    btn.recenter.label = t('recenter'); btn.exit.label = t('exit');
    buttons.forEach(b => b.draw());
    const gap = 0.014;
    rows.forEach((row, ri) => {
      const items = S.lang === 'ar' ? [...row].reverse() : row;
      const total = items.reduce((s, id) => s + btn[id].w, 0) + gap * (items.length - 1);
      let x = -total / 2;
      for (const id of items) { const b = btn[id]; b.mesh.position.set(x + b.w / 2, -PH / 2 - 0.065 - ri * (BH + gap), 0.005); x += b.w + gap; }
    });
    camPanel.visible = core.camOn;
  }

  // panel drawing
  let panelSig = '';
  function drawPanel() {
    const sig = [core.rev, S.lang, core.orbState()].join('|');
    if (sig === panelSig) return; panelSig = sig;
    const { g, c, tex } = panel; const W = c.width, H = c.height, rtl = S.lang === 'ar';
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(14,16,19,.95)'; roundRect(g, 2, 2, W - 4, H - 4, 40); g.fill();
    g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 3; g.stroke();
    g.textBaseline = 'middle';
    g.direction = rtl ? 'rtl' : 'ltr'; g.textAlign = rtl ? 'right' : 'left';
    g.fillStyle = '#eceef1'; g.font = `600 42px ${FONT}`; g.fillText('Quest AI', rtl ? W - 56 : 56, 64);
    g.direction = 'ltr'; g.textAlign = rtl ? 'left' : 'right'; g.fillStyle = '#8b929c'; g.font = `500 26px ${MONO}`;
    g.fillText(`${core.SHORT[S.provider]} · ${core.modelFor(S.provider)}`, rtl ? 56 : W - 56, 64);
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(48, 110, W - 96, 2);

    const LH = 52, top = 134, bottom = H - 112, maxW = W - 170;
    const lines = [];
    for (const m of core.msgs) {
      const txt = m.text || (m.role === 'assistant' && core.busy ? '…' : '');
      if (m._xrKey !== txt) {
        g.font = `${m.role === 'user' ? 500 : 400} 36px ${FONT}`; g.direction = isRTL(txt) ? 'rtl' : 'ltr';
        m._xr = wrapText(g, txt, maxW).map(s => ({ s, rtl: isRTL(txt) })); m._xrKey = txt;
      }
      for (const l of m._xr) lines.push({ ...l, role: m.role, err: m.err });
      lines.push({ gap: true });
    }
    const visible = Math.floor((bottom - top) / LH);
    let y = top;
    for (const it of lines.slice(Math.max(0, lines.length - visible))) {
      if (it.s !== undefined) {
        if (it.role === 'assistant') { g.fillStyle = it.err ? '#ff4d3d' : LIME; g.fillRect(rtl ? W - 60 : 56, y + 6, 4, LH - 12); }
        g.fillStyle = it.err ? '#ffb4ac' : it.role === 'user' ? '#8b929c' : '#eceef1';
        g.direction = it.rtl ? 'rtl' : 'ltr'; g.textAlign = it.rtl ? 'right' : 'left';
        g.font = `${it.role === 'user' ? 500 : 400} 36px ${FONT}`;
        g.fillText(it.s, it.rtl ? W - 78 : 78, y + LH / 2);
      }
      y += LH;
    }
    if (!core.msgs.length) {
      g.fillStyle = '#8b929c'; g.textAlign = 'center'; g.direction = rtl ? 'rtl' : 'ltr'; g.font = `500 36px ${FONT}`;
      g.fillText(t('emptyBody'), W / 2, (top + bottom) / 2, W - 120);
    }
    g.fillStyle = 'rgba(255,255,255,.08)'; g.fillRect(48, H - 100, W - 96, 2);
    g.textAlign = 'center'; g.direction = rtl ? 'rtl' : 'ltr';
    const st = core.orbState();
    g.fillStyle = core.statusErr ? '#ff9c90' : '#c9ccd2'; g.font = `500 30px ${FONT}`;
    g.fillText(core.statusText || t('st_' + st), W / 2, H - 64);
    g.fillStyle = '#5c636d'; g.font = `400 22px ${FONT}`; g.fillText(t('hints'), W / 2, H - 26);
    tex.needsUpdate = true;
  }
  function drawHudLayer() {
    // mirror the 2D HUD canvas (boxes + scan) onto the 3D camera preview
    const src = document.getElementById('hud');
    const { g, c, tex } = hudLayer;
    g.clearRect(0, 0, c.width, c.height);
    if (src.width && src.height) g.drawImage(src, 0, 0, c.width, c.height);
    tex.needsUpdate = true;
  }

  // controllers & hands (model factories are optional — they fetch assets from a CDN)
  let ctrlFactory = null, handFactory = null;
  try {
    ctrlFactory = new (await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/webxr/XRControllerModelFactory.js')).XRControllerModelFactory();
    handFactory = new (await import('https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/webxr/XRHandModelFactory.js')).XRHandModelFactory();
  } catch {}
  const pointers = [];
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]);
  let grabbedBy = null;
  const pulse = (pt, v, ms) => { try { pt.source?.gamepad?.hapticActuators?.[0]?.pulse?.(v, ms); } catch {} };
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    ray.scale.z = 2;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 8), new THREE.MeshBasicMaterial({ color: 0xd4ff3f }));
    dot.visible = false; ctrl.add(ray); scene.add(dot);
    const pt = { ctrl, ray, dot, hovered: null, onPanel: false, pressed: null, source: null, prev: [] };
    ctrl.addEventListener('connected', e => { pt.source = e.data; ray.visible = e.data.targetRayMode === 'tracked-pointer'; });
    ctrl.addEventListener('disconnected', () => { pt.source = null; pt.hovered = null; });
    ctrl.addEventListener('selectstart', () => {
      const b = pt.hovered; if (!b) return;
      pt.pressed = b; pulse(pt, 0.6, 30);
      if (b.hold) { core.ensureAudioCtx(); core.startRecording(); } else b.onPress?.();
    });
    ctrl.addEventListener('selectend', () => { const b = pt.pressed; pt.pressed = null; if (b?.hold) core.stopRecording(); });
    ctrl.addEventListener('squeezestart', () => { if ((pt.onPanel || pt.hovered) && !grabbedBy) { grabbedBy = pt; ctrl.attach(ui); pulse(pt, 0.5, 40); } });
    ctrl.addEventListener('squeezeend', () => {
      if (grabbedBy !== pt) return;
      grabbedBy = null; scene.attach(ui);
      const head = new THREE.Vector3(); renderer.xr.getCamera().getWorldPosition(head);
      ui.lookAt(head.x, ui.position.y, head.z);
    });
    scene.add(ctrl);
    if (ctrlFactory) { const grip = renderer.xr.getControllerGrip(i); grip.add(ctrlFactory.createControllerModel(grip)); scene.add(grip); }
    if (handFactory) { const hand = renderer.xr.getHand(i); hand.add(handFactory.createHandModel(hand, 'mesh')); scene.add(hand); }
    pointers.push(pt);
  }
  const hitTargets = [panel.mesh, ...buttons.map(b => b.mesh)];

  const raycaster = new THREE.Raycaster();
  const tmpM = new THREE.Matrix4(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), col = new THREE.Color();
  let lastT = 0, pttHeld = false;
  function recenter() {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(v1); cam.getWorldDirection(v2);
    v2.y = 0; if (v2.lengthSq() < 1e-4) v2.set(0, 0, -1); v2.normalize();
    ui.position.copy(v1).addScaledVector(v2, 1.25); ui.position.y = Math.max(v1.y - 0.1, 0.8);
    ui.lookAt(v1.x, ui.position.y, v1.z);
  }
  function frame(time) {
    const dt = Math.min(0.1, (time - lastT) / 1000 || 0); lastT = time;
    if (needsRecenter) { renderer.xr.getCamera().getWorldPosition(v1); if (v1.lengthSq() > 0) { recenter(); needsRecenter = false; } }
    core.uiFrame(time);
    // input
    const hovered = new Set(); let ptt = false;
    for (const pt of pointers) {
      if (!pt.source) { pt.dot.visible = false; continue; }
      tmpM.identity().extractRotation(pt.ctrl.matrixWorld);
      raycaster.ray.origin.setFromMatrixPosition(pt.ctrl.matrixWorld);
      raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
      const hit = grabbedBy === pt ? null : raycaster.intersectObjects(hitTargets, false)[0];
      const b = hit?.object.userData.button || null;
      if (b && b !== pt.hovered) pulse(pt, 0.2, 12);
      pt.hovered = b; pt.onPanel = !!hit && !b;
      pt.ray.scale.z = hit ? hit.distance : 2;
      pt.dot.visible = !!hit; if (hit) pt.dot.position.copy(hit.point);
      if (b) hovered.add(b);
      const gp = pt.source.gamepad;
      if (gp) {
        const B = i => !!gp.buttons[i]?.pressed, edge = i => B(i) && !pt.prev[i];
        if (B(4)) ptt = true;
        if (edge(5)) core.ask('', { forceImage: true });
        if (edge(3)) needsRecenter = true;
        pt.prev = gp.buttons.map(x => x.pressed);
      }
    }
    for (const b of buttons) {
      const h = hovered.has(b);
      if (h !== b.hover) { b.hover = h; b.draw(); }
      b.hoverT += ((h ? 1 : 0) - b.hoverT) * Math.min(1, dt * 14);
      b.mesh.scale.setScalar(1 + b.hoverT * 0.05); b.mesh.position.z = 0.005 + b.hoverT * 0.01;
    }
    if (ptt !== pttHeld) { pttHeld = ptt; if (ptt) { core.ensureAudioCtx(); core.startRecording(); } else core.stopRecording(); }
    // orb
    const st = core.orbState();
    col.setHex(STATE_COLOR[st]); orbMat.color.lerp(col, Math.min(1, dt * 8)); ringMat.color.copy(orbMat.color);
    const lvl = st === 'hearing' || st === 'listening' ? core.inLevel : st === 'speaking' ? core.outLevel : 0;
    orb.scale.setScalar(1 + lvl * 0.6);
    ring.scale.setScalar(1 + lvl * 0.9 + 0.05 * Math.sin(time / 300));
    ring.rotation.z += dt * (st === 'thinking' || st === 'looking' ? 3 : 0.3);
    relabel(); drawPanel();
    if (core.camOn) drawHudLayer();
    renderer.render(scene, camera);
  }

  return {
    presenting: () => renderer.xr.isPresenting,
    async enter(mode) {
      const session = await navigator.xr.requestSession(mode, { requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'] });
      renderer.xr.setReferenceSpaceType('local-floor');
      await renderer.xr.setSession(session);
      const ar = mode === 'immersive-ar';
      env.visible = !ar;
      renderer.setClearColor(0x000000, ar ? 0 : 1);
      renderer.domElement.style.display = 'block';
      needsRecenter = true; labelSig = ''; panelSig = '';
      renderer.setAnimationLoop(frame);
      session.addEventListener('end', () => {
        renderer.setAnimationLoop(null);
        renderer.domElement.style.display = 'none';
        core.stopRecording(); pttHeld = false;
        if (grabbedBy) { scene.attach(ui); grabbedBy = null; }
      });
    },
  };
}
