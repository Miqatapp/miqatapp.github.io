import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { PROVIDERS, chat, listModels, transcribe, openaiSpeech } from './ai.js';
import { t as tr } from './i18n.js';

const $ = id => document.getElementById(id);

/* ================= settings ================= */
const KEY = 'questai.settings';
const DEF = {
  lang: 'ar',
  provider: 'openai', models: {},
  keys: { openai: '', anthropic: '', gemini: '', custom: '' },
  customBase: 'https://openrouter.ai/api/v1',
  system: '', ttsOn: true, ttsEngine: 'auto', ttsVoice: 'alloy', sttEngine: 'auto',
  camAttach: true, camDevice: '',
};
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEF, ...j, keys: { ...DEF.keys, ...(j.keys || {}) }, models: { ...(j.models || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEF)); }
}
const S = load();
// if no key for the selected provider but another one has a key, switch to it
if (!S.keys[S.provider]) { const p = Object.keys(PROVIDERS).find(p => S.keys[p]); if (p) S.provider = p; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
const t = (k, v) => tr(S.lang, k, v);
const modelFor = p => (S.models[p] || PROVIDERS[p].model || '').trim();
const systemPrompt = () => S.system.trim() || t('sysDefault');
const SHORT = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', custom: 'Custom' };

/* ================= chat state ================= */
const msgs = []; // {role, text, image, err, skip, el, imgEl}
let busy = false, abortCtl = null;
let statusText = '', statusErr = false;
let panelDirty = true;

function setStatus(s, err = false) {
  statusText = s; statusErr = err;
  const el = $('status'); el.textContent = s; el.classList.toggle('err', err);
  panelDirty = true;
}

function clean(s) {
  return (s || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

function renderEmpty() {
  const log = $('log');
  if (!msgs.length) log.innerHTML = `<div class="empty">${escapeHtml(t('empty'))}</div>`;
  else log.querySelector('.empty')?.remove();
}
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pushMsg(m) {
  msgs.push(m);
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  if (m.image) {
    const img = new Image(); img.src = m.image; el.appendChild(img);
    m.imgEl = img; img.onload = () => { panelDirty = true; };
  }
  el.appendChild(document.createElement('span'));
  m.el = el;
  renderEmpty();
  $('log').appendChild(el);
  updateMsg(m);
  scroll = 0;
}
function updateMsg(m) {
  m.el.lastChild.textContent = m.text;
  m.el.classList.toggle('err', !!m.err);
  m._wrapKey = null;
  const log = $('log'); log.scrollTop = log.scrollHeight;
  panelDirty = true;
}
function removeMsg(m) { const i = msgs.indexOf(m); if (i >= 0) msgs.splice(i, 1); m.el?.remove(); renderEmpty(); panelDirty = true; }
function clearChat() { stopAll(); msgs.length = 0; $('log').innerHTML = ''; renderEmpty(); setStatus(''); scroll = 0; }

async function ask(text, { forceImage = false } = {}) {
  text = (text || '').trim();
  let image = null;
  if (camStream && (forceImage || S.camAttach)) image = snapshot();
  if (forceImage && !camStream) {
    if (!(await camStart())) return;
    await new Promise(r => setTimeout(r, 400));
    image = snapshot();
  }
  if (!text && image) text = t('whatsThisQ');
  if (!text) return;

  const p = S.provider, key = (S.keys[p] || '').trim();
  if (!key) { setStatus(t('needKey', { p: PROVIDERS[p].label }) + ' — ' + t('settingsHint'), true); return; }
  if (busy) stopAll();
  stopSpeaking();

  const u = { role: 'user', text, image };
  const a = { role: 'assistant', text: '' };
  pushMsg(u); pushMsg(a);
  const ctl = new AbortController();
  abortCtl = ctl; busy = true;
  setStatus(t('thinking'));
  try {
    const history = msgs.filter(m => m !== a && !m.skip && m.text).map(m => ({ role: m.role, text: m.text, image: m.image }));
    const full = await chat({
      provider: p, key, model: modelFor(p), base: S.customBase, system: systemPrompt(),
      messages: history, signal: ctl.signal,
      onDelta: s => { a.text = clean(s); updateMsg(a); if (statusText) setStatus(''); },
    });
    a.text = clean(full) || '…'; updateMsg(a); setStatus('');
    if (S.ttsOn && full.trim()) speak(a.text);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!a.text) { removeMsg(a); u.skip = true; } else a.text += ' …';
      setStatus(t('stopped'));
    } else {
      u.skip = true; a.skip = true; a.err = true;
      a.text = t('error') + ': ' + (e.message || e); updateMsg(a); setStatus('');
    }
  } finally {
    if (abortCtl === ctl) { busy = false; abortCtl = null; }
    panelDirty = true;
  }
}
function stopAll() {
  abortCtl?.abort(); abortCtl = null; busy = false;
  stopSpeaking();
  if (wantRec) cancelRecording();
}

/* ================= voice in ================= */
let audioCtx = null, micStream = null, rec = null, wantRec = false;
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
async function ensureMic() {
  if (micStream && micStream.getAudioTracks().some(t => t.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return micStream;
}
function sttReady() {
  const e = S.sttEngine;
  if (e === 'openai') return !!S.keys.openai;
  if (e === 'gemini') return !!S.keys.gemini;
  return !!(S.keys.openai || S.keys.gemini);
}
async function startRecording() {
  if (wantRec) return;
  if (!sttReady()) { setStatus(t('needSttKey'), true); return; }
  wantRec = true;
  stopSpeaking();
  const ctx = ensureAudioCtx();
  try { await ensureMic(); } catch { wantRec = false; setStatus(t('noMic'), true); return; }
  if (!wantRec) return; // released before mic was ready
  const src = ctx.createMediaStreamSource(micStream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  const chunks = [];
  proc.onaudioprocess = e => chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  rec = { src, proc, mute, chunks, rate: ctx.sampleRate };
  setMicUI(true);
  setStatus(t('listening'));
}
function teardownRec() {
  const r = rec; rec = null; wantRec = false; setMicUI(false);
  if (r) { r.src.disconnect(); r.proc.disconnect(); r.mute.disconnect(); }
  return r;
}
function cancelRecording() { teardownRec(); }
async function stopRecording() {
  if (!wantRec) return;
  const r = teardownRec();
  if (!r) return;
  const len = r.chunks.reduce((n, c) => n + c.length, 0);
  if (len < r.rate * 0.4) { setStatus(t('tooShort')); return; }
  setStatus(t('transcribing'));
  try {
    const text = await transcribe(encodeWav(r.chunks, len, r.rate, 16000), {
      engine: S.sttEngine, openaiKey: S.keys.openai.trim(), geminiKey: S.keys.gemini.trim(),
      geminiModel: S.provider === 'gemini' ? modelFor('gemini') : PROVIDERS.gemini.model,
    });
    if (!text) { setStatus(t('heardNothing')); return; }
    setStatus('');
    await ask(text);
  } catch (e) { setStatus(t('error') + ': ' + e.message, true); }
}
function encodeWav(chunks, len, inRate, outRate) {
  const data = new Float32Array(len); let o = 0;
  for (const c of chunks) { data.set(c, o); o += c.length; }
  const ratio = inRate / outRate, n = Math.floor(len / ratio);
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    // average the source samples in this window (cheap low-pass)
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b && j < len; j++) s += data[j];
    s = Math.max(-1, Math.min(1, s / (b - a)));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ================= voice out ================= */
let audioEl = null, ttsCtl = null;
async function speak(text) {
  stopSpeaking();
  const eng = S.ttsEngine === 'auto' ? (S.keys.openai ? 'openai' : 'browser') : S.ttsEngine;
  if (eng === 'openai' && S.keys.openai) {
    const ctl = ttsCtl = new AbortController();
    try {
      const blob = await openaiSpeech(text, S.keys.openai.trim(), S.ttsVoice, ctl.signal);
      if (ctl.signal.aborted) return;
      audioEl = new Audio(URL.createObjectURL(blob));
      await audioEl.play();
      return;
    } catch (e) { if (e.name === 'AbortError' || ctl.signal.aborted) return; }
  }
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[؀-ۿ]/.test(text) ? 'ar-SA' : 'en-US';
    const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    speechSynthesis.speak(u);
  }
}
function stopSpeaking() {
  ttsCtl?.abort(); ttsCtl = null;
  if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); audioEl = null; }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

/* ================= camera ================= */
let camStream = null;
const camVideo = $('cam-video');
async function camStart() {
  const base = { width: { ideal: 1280 }, height: { ideal: 960 } };
  const tryGet = c => navigator.mediaDevices.getUserMedia({ video: { ...base, ...c }, audio: false });
  try {
    try { camStream = await tryGet(S.camDevice ? { deviceId: { exact: S.camDevice } } : { facingMode: 'environment' }); }
    catch (e) { if (!S.camDevice) throw e; camStream = await tryGet({}); }
  } catch (e) { setStatus(t('noCam', { e: e.message || e.name }), true); return false; }
  camVideo.srcObject = camStream;
  await camVideo.play().catch(() => {});
  camStream.getVideoTracks()[0]?.addEventListener('ended', camStop);
  populateCams();
  updateCamUI();
  return true;
}
function camStop() {
  camStream?.getTracks().forEach(tk => tk.stop());
  camStream = null; camVideo.srcObject = null;
  updateCamUI();
}
const camToggle = () => camStream ? camStop() : camStart();
const snapCanvas = document.createElement('canvas');
function snapshot() {
  const v = camVideo;
  if (!v.videoWidth) return null;
  const sc = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  snapCanvas.width = Math.round(v.videoWidth * sc); snapCanvas.height = Math.round(v.videoHeight * sc);
  snapCanvas.getContext('2d').drawImage(v, 0, 0, snapCanvas.width, snapCanvas.height);
  return snapCanvas.toDataURL('image/jpeg', 0.82);
}
async function populateCams() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const sel = $('cam-device');
  sel.innerHTML = '';
  sel.add(new Option(t('auto'), ''));
  devs.forEach((d, i) => sel.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  sel.value = devs.some(d => d.deviceId === S.camDevice) ? S.camDevice : '';
}
function updateCamUI() {
  const on = !!camStream;
  $('cam-box').hidden = !on;
  $('cam').textContent = on ? t('camOff') : t('camOn');
  $('cam').classList.toggle('on', on);
  if (vr) { vr.camPanel.visible = on; vr.btn.cam.active = on; vr.btn.cam.label = on ? t('camOff') : t('camOn'); vr.btn.cam.draw(); }
}

/* ================= DOM wiring ================= */
function setMicUI(on) {
  $('mic').classList.toggle('on', on);
  if (vr) { vr.btn.mic.active = on; vr.btn.mic.draw(); }
}

function applyLang() {
  const html = document.documentElement;
  html.lang = S.lang; html.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  $('lang').textContent = '🌐 ' + t('lang');
  $('text').placeholder = t('typePh');
  $('system').placeholder = t('sysDefault');
  document.title = t('title');
  renderEmpty();
  updateCamUI();
  updateXRNote();
  if (vr) vr.relabel();
  panelDirty = true;
}

function fillProviders() {
  const sel = $('provider'); sel.innerHTML = '';
  for (const [id, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, id));
  sel.value = S.provider;
}
function syncProviderUI() {
  $('provider').value = S.provider;
  $('model').value = modelFor(S.provider);
  $('custom-fields').style.display = S.provider === 'custom' ? '' : 'none';
  $('models').innerHTML = '';
  $('models-status').textContent = '';
  panelDirty = true;
  if (vr) { vr.btn.provider.label = '🤖 ' + SHORT[S.provider]; vr.btn.provider.draw(); }
}
function bindSettings() {
  fillProviders(); syncProviderUI();
  $('provider').onchange = () => { S.provider = $('provider').value; save(); syncProviderUI(); };
  $('model').onchange = () => { S.models[S.provider] = $('model').value.trim(); save(); panelDirty = true; };
  for (const p of Object.keys(PROVIDERS)) {
    const el = $('key-' + p); el.value = S.keys[p] || '';
    el.oninput = () => { S.keys[p] = el.value.trim(); save(); };
  }
  document.querySelectorAll('.eye').forEach(b => b.onclick = () => { const i = $(b.dataset.for); i.type = i.type === 'password' ? 'text' : 'password'; });
  const bindVal = (id, k, ev = 'change') => { const el = $(id); el.value = S[k]; el.addEventListener(ev, () => { S[k] = el.value; save(); }); };
  const bindChk = (id, k) => { const el = $(id); el.checked = !!S[k]; el.onchange = () => { S[k] = el.checked; save(); }; };
  bindVal('custom-base', 'customBase', 'input');
  const preset = $('custom-preset');
  preset.value = [...preset.options].some(o => o.value && o.value === S.customBase) ? S.customBase : '';
  preset.onchange = () => { if (preset.value) { S.customBase = $('custom-base').value = preset.value; save(); } };
  bindVal('system', 'system', 'input');
  bindVal('tts-engine', 'ttsEngine'); bindVal('tts-voice', 'ttsVoice'); bindVal('stt-engine', 'sttEngine');
  bindChk('tts-on', 'ttsOn'); bindChk('cam-attach', 'camAttach');
  $('cam-device').onchange = async () => { S.camDevice = $('cam-device').value; save(); if (camStream) { camStop(); await camStart(); } };
  populateCams();

  $('fetch-models').onclick = async () => {
    const p = S.provider, out = $('models-status');
    out.textContent = '…'; out.style.color = '';
    try {
      const ids = await listModels({ provider: p, key: (S.keys[p] || '').trim(), base: S.customBase });
      $('models').innerHTML = ids.map(id => `<option value="${escapeHtml(id)}">`).join('');
      out.textContent = t('modelsLoaded', { n: ids.length });
    } catch (e) { out.textContent = t('error') + ': ' + e.message; out.style.color = '#ff8b93'; }
  };
}
function bindChat() {
  $('send').onclick = () => { const v = $('text').value; $('text').value = ''; ask(v); };
  $('text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('send').click(); } });
  const mic = $('mic');
  mic.addEventListener('pointerdown', e => { e.preventDefault(); mic.setPointerCapture?.(e.pointerId); ensureAudioCtx(); startRecording(); });
  for (const ev of ['pointerup', 'pointercancel']) mic.addEventListener(ev, () => stopRecording());
  mic.addEventListener('contextmenu', e => e.preventDefault());
  $('cam').onclick = camToggle;
  $('snap').onclick = () => ask('', { forceImage: true });
  $('stop').onclick = () => { stopAll(); setStatus(t('stopped')); };
  $('clear').onclick = clearChat;
  $('lang').onclick = () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; save(); applyLang(); };
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'tab-' + b.dataset.tab));
  });
}

/* ================= PWA ================= */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('install').hidden = false; });
$('install').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('install').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

/* ================= XR scene ================= */
let vr = null;      // VR UI, created lazily on first session
let scroll = 0;     // lines scrolled up from the bottom
const FONT = '"Noto Sans Arabic", system-ui, sans-serif';
const isRTL = s => /[֐-ࣿ]/.test(s);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(0.5);
renderer.domElement.className = 'xr';
renderer.domElement.style.display = 'none';
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 100);

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function canvasPlane(w, h, pxPerM) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * pxPerM); c.height = Math.round(h * pxPerM);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  return { c, g: c.getContext('2d'), tex, mesh };
}

function buildVR() {
  const ui = new THREE.Group(); scene.add(ui);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 2.2));

  // VR-only environment
  const env = new THREE.Group(); scene.add(env);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: 'varying vec3 p; void main(){ float h = p.y*.5+.5; vec3 c = mix(vec3(.02,.03,.06), vec3(.09,.12,.25), smoothstep(.35,.9,h)); gl_FragColor = vec4(c,1.); }',
  }));
  env.add(sky);
  const grid = new THREE.GridHelper(60, 60, 0x34508a, 0x18233a);
  grid.material.transparent = true; grid.material.opacity = 0.6; env.add(grid);

  // chat panel
  const PW = 1.1, PH = 0.95, PX = 1400;
  const panel = canvasPlane(PW, PH, PX);
  panel.mesh.renderOrder = 1;
  ui.add(panel.mesh);

  // camera preview (left of panel)
  const camTex = new THREE.VideoTexture(camVideo); camTex.colorSpace = THREE.SRGBColorSpace;
  const camPanel = new THREE.Group();
  const camMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.36), new THREE.MeshBasicMaterial({ map: camTex }));
  const camLabel = canvasPlane(0.48, 0.06, 1000);
  camLabel.mesh.position.y = 0.22;
  camPanel.add(camMesh, camLabel.mesh);
  camPanel.position.set(-0.86, 0.12, 0.12); camPanel.rotation.y = 0.45;
  camPanel.visible = false;
  ui.add(camPanel);
  const drawCamLabel = () => {
    const { g, c, tex } = camLabel; g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(239,77,90,.95)'; roundRect(g, 0, 0, c.width, c.height, 24); g.fill();
    g.fillStyle = '#fff'; g.font = `600 30px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.direction = S.lang === 'ar' ? 'rtl' : 'ltr';
    g.fillText('● ' + t('camLive') + (S.camAttach ? ' · ' + t('camWillAttach') : ''), c.width / 2, c.height / 2 + 2);
    tex.needsUpdate = true;
  };

  // buttons
  const buttons = [];
  const BH = 0.085;
  function makeButton(id, w, onPress, opts = {}) {
    const p = canvasPlane(w, BH, 1400);
    p.mesh.position.z = 0.005;
    const b = { id, ...p, w, onPress, hover: false, active: false, label: '', ...opts };
    b.draw = () => {
      const { g, c, tex } = b; g.clearRect(0, 0, c.width, c.height);
      g.fillStyle = b.active ? '#ef4d5a' : b.hover ? '#4f8cff' : 'rgba(30,40,62,.96)';
      roundRect(g, 3, 3, c.width - 6, c.height - 6, 34); g.fill();
      g.strokeStyle = b.hover ? '#a9c6ff' : 'rgba(120,150,210,.35)'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.direction = S.lang === 'ar' ? 'rtl' : 'ltr';
      let size = 46; g.font = `600 ${size}px ${FONT}`;
      while (g.measureText(b.label).width > c.width - 40 && size > 22) { size -= 2; g.font = `600 ${size}px ${FONT}`; }
      g.fillText(b.label, c.width / 2, c.height / 2 + 3);
      tex.needsUpdate = true;
    };
    p.mesh.userData.button = b;
    ui.add(p.mesh); buttons.push(b);
    return b;
  }
  const btn = {
    mic: makeButton('mic', 0.44, null, { hold: true, labelKey: 'holdTalk' }),
    cam: makeButton('cam', 0.24, camToggle),
    snap: makeButton('snap', 0.22, () => ask('', { forceImage: true }), { labelKey: 'whatsThis' }),
    stop: makeButton('stop', 0.17, () => { stopAll(); setStatus(t('stopped')); }, { labelKey: 'stop' }),
    up: makeButton('up', 0.1, () => { scroll += 4; panelDirty = true; }, { fixed: '▲' }),
    down: makeButton('down', 0.1, () => { scroll = Math.max(0, scroll - 4); panelDirty = true; }, { fixed: '▼' }),
    clear: makeButton('clear', 0.16, clearChat, { labelKey: 'clear' }),
    lang: makeButton('lang', 0.16, () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; save(); applyLang(); }),
    provider: makeButton('provider', 0.21, cycleProvider),
    recenter: makeButton('recenter', 0.16, () => { needsRecenter = true; }, { labelKey: 'recenter' }),
    exit: makeButton('exit', 0.14, () => renderer.xr.getSession()?.end(), { labelKey: 'exit' }),
  };
  const rows = [['mic', 'cam', 'snap', 'stop'], ['up', 'down', 'clear', 'lang', 'provider', 'recenter', 'exit']];
  function layout() {
    const gap = 0.014;
    rows.forEach((row, ri) => {
      const items = S.lang === 'ar' ? [...row].reverse() : row;
      const total = items.reduce((s, id) => s + btn[id].w, 0) + gap * (items.length - 1);
      let x = -total / 2;
      for (const id of items) { const b = btn[id]; b.mesh.position.set(x + b.w / 2, -PH / 2 - 0.065 - ri * (BH + gap), 0.005); x += b.w + gap; }
    });
  }
  function relabel() {
    for (const b of buttons) b.label = b.fixed || (b.labelKey ? t(b.labelKey) : b.label);
    btn.lang.label = '🌐 ' + t('lang');
    btn.provider.label = '🤖 ' + SHORT[S.provider];
    btn.cam.label = camStream ? t('camOff') : t('camOn');
    buttons.forEach(b => b.draw());
    drawCamLabel();
    layout();
    panelDirty = true;
  }

  // controllers & hands
  const ctrlFactory = new XRControllerModelFactory();
  const handFactory = new XRHandModelFactory();
  const pointers = [];
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x9fc0ff, transparent: true, opacity: 0.8 }));
    ray.scale.z = 2;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    dot.visible = false;
    ctrl.add(ray); scene.add(dot);
    const pt = { ctrl, ray, dot, hovered: null, onPanel: false, pressed: null, source: null, prev: [] };
    ctrl.addEventListener('connected', e => { pt.source = e.data; ray.visible = e.data.targetRayMode === 'tracked-pointer'; });
    ctrl.addEventListener('disconnected', () => { pt.source = null; pt.hovered = null; });
    ctrl.addEventListener('selectstart', () => {
      const b = pt.hovered; if (!b) return;
      pt.pressed = b; pulse(pt, 0.6, 30);
      if (b.hold) { ensureAudioCtx(); startRecording(); } else b.onPress?.();
    });
    ctrl.addEventListener('selectend', () => {
      const b = pt.pressed; pt.pressed = null;
      if (b?.hold) stopRecording();
    });
    scene.add(ctrl);
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(ctrlFactory.createControllerModel(grip)); scene.add(grip);
    const hand = renderer.xr.getHand(i);
    hand.add(handFactory.createHandModel(hand, 'mesh')); scene.add(hand);
    pointers.push(pt);
  }

  vr = { ui, env, panel, PW, PH, PX, camPanel, buttons, btn, pointers, relabel, drawCamLabel,
         hitTargets: [panel.mesh, ...buttons.map(b => b.mesh)] };
  relabel();
}

function pulse(pt, v, ms) { try { pt.source?.gamepad?.hapticActuators?.[0]?.pulse?.(v, ms); } catch {} }

function cycleProvider() {
  const ids = Object.keys(PROVIDERS);
  const withKey = ids.filter(p => S.keys[p]);
  const list = withKey.length ? withKey : ids;
  S.provider = list[(list.indexOf(S.provider) + 1) % list.length];
  save(); syncProviderUI();
}

/* ---------- chat panel drawing ---------- */
function wrapText(g, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const tt = line ? line + ' ' + word : word;
      if (g.measureText(tt).width > maxW && line) {
        out.push(line); line = word;
        while (g.measureText(line).width > maxW && line.length > 1) { // very long tokens
          let k = line.length - 1; while (k > 1 && g.measureText(line.slice(0, k)).width > maxW) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      } else line = tt;
    }
    out.push(line);
  }
  return out;
}
let dots = 0;
function drawPanel() {
  const { panel: { g, c, tex } } = vr;
  const W = c.width, H = c.height;
  const rtlUI = S.lang === 'ar';
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(12,16,26,0.93)'; roundRect(g, 0, 0, W, H, 44); g.fill();
  g.strokeStyle = 'rgba(110,145,220,.45)'; g.lineWidth = 4; g.stroke();

  // header
  g.textBaseline = 'middle';
  g.direction = rtlUI ? 'rtl' : 'ltr'; g.textAlign = rtlUI ? 'right' : 'left';
  const hx = rtlUI ? W - 48 : 48;
  g.fillStyle = '#eaf0ff'; g.font = `700 44px ${FONT}`;
  g.fillText(t('title'), hx, 62);
  g.textAlign = rtlUI ? 'left' : 'right';
  g.fillStyle = '#8ea4d0'; g.font = `500 30px ${FONT}`;
  g.direction = 'ltr';
  g.fillText(`${SHORT[S.provider]} · ${modelFor(S.provider) || '—'}`, rtlUI ? 48 : W - 48, 62);
  g.fillStyle = 'rgba(110,145,220,.25)'; g.fillRect(40, 108, W - 80, 2);

  // messages
  const LH = 54, top = 132, bottom = H - 120, maxW = W - 170;
  g.font = `400 38px ${FONT}`;
  const lines = [];
  for (const m of msgs) {
    const txt = m.text || (m.role === 'assistant' && busy ? '…' : '');
    const key = txt + '|' + W;
    if (m._wrapKey !== key) {
      const rtl = isRTL(txt);
      g.direction = rtl ? 'rtl' : 'ltr';
      m._lines = wrapText(g, txt, maxW).map(s => ({ s, rtl }));
      m._wrapKey = key;
    }
    if (m.imgEl?.complete && m.imgEl.naturalWidth) lines.push({ img: m.imgEl, role: m.role }, ...Array(3).fill({ skip: true, role: m.role }));
    for (const l of m._lines) lines.push({ ...l, role: m.role, err: m.err });
    lines.push({ gap: true });
  }
  const visible = Math.floor((bottom - top) / LH);
  scroll = Math.max(0, Math.min(scroll, lines.length - visible));
  const start = Math.max(0, lines.length - visible - scroll);
  let y = top;
  for (const it of lines.slice(start, start + visible)) {
    if (it.role === 'user' && !it.gap) { g.fillStyle = 'rgba(79,140,255,0.16)'; g.fillRect(36, y, W - 72, LH); }
    if (it.img) {
      const h = LH * 4 - 12, w = h * it.img.naturalWidth / it.img.naturalHeight;
      g.drawImage(it.img, rtlUI ? W - 70 - w : 70, y + 4, w, h);
    } else if (it.s !== undefined) {
      g.fillStyle = it.err ? '#ff9aa2' : it.role === 'user' ? '#cfe0ff' : '#eef2f8';
      g.direction = it.rtl ? 'rtl' : 'ltr'; g.textAlign = it.rtl ? 'right' : 'left';
      g.font = `${it.role === 'user' ? 600 : 400} 38px ${FONT}`;
      g.fillText(it.s, it.rtl ? W - 70 : 70, y + LH / 2);
    }
    y += LH;
  }
  if (scroll > 0) { g.fillStyle = '#8ea4d0'; g.textAlign = 'center'; g.font = `600 30px ${FONT}`; g.fillText('▼ ' + scroll, W / 2, bottom + 6); }
  if (!msgs.length) {
    g.fillStyle = '#8a96aa'; g.textAlign = 'center'; g.direction = rtlUI ? 'rtl' : 'ltr'; g.font = `500 40px ${FONT}`;
    g.fillText(t('empty'), W / 2, (top + bottom) / 2);
    if (!S.keys[S.provider]) { g.fillStyle = '#ffb37a'; g.font = `500 32px ${FONT}`; g.fillText(t('settingsHint'), W / 2, (top + bottom) / 2 + 64); }
  }

  // footer: status + hints
  g.fillStyle = 'rgba(110,145,220,.25)'; g.fillRect(40, H - 108, W - 80, 2);
  g.direction = rtlUI ? 'rtl' : 'ltr'; g.textAlign = 'center';
  let st = statusText;
  if (busy && st === t('thinking')) st = t('thinking').replace(/\.+$/, '') + '.'.repeat(1 + (dots % 3));
  g.fillStyle = statusErr ? '#ff8b93' : '#b8c6e4'; g.font = `500 32px ${FONT}`;
  g.fillText(st || ' ', W / 2, H - 72);
  g.fillStyle = '#66738c'; g.font = `400 24px ${FONT}`;
  g.fillText(t('hints'), W / 2, H - 30);
  tex.needsUpdate = true;
}

/* ---------- frame loop ---------- */
const raycaster = new THREE.Raycaster();
const tmpM = new THREE.Matrix4(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
let needsRecenter = false, lastT = 0, scrollAcc = 0, pttHeld = false, lastDots = 0;

function recenter() {
  const cam = renderer.xr.getCamera();
  cam.getWorldPosition(v1); cam.getWorldDirection(v2);
  v2.y = 0; if (v2.lengthSq() < 1e-4) v2.set(0, 0, -1); v2.normalize();
  vr.ui.position.copy(v1).addScaledVector(v2, 1.25);
  vr.ui.position.y = Math.max(v1.y - 0.08, 0.8);
  vr.ui.lookAt(v1.x, vr.ui.position.y, v1.z);
}

function updateInput(dt) {
  const hovered = new Set();
  let ptt = false, scrollY = 0;
  for (const pt of vr.pointers) {
    if (!pt.source) { pt.dot.visible = false; continue; }
    tmpM.identity().extractRotation(pt.ctrl.matrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(pt.ctrl.matrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpM);
    const hit = raycaster.intersectObjects(vr.hitTargets, false)[0];
    const b = hit?.object.userData.button || null;
    if (b && b !== pt.hovered) pulse(pt, 0.2, 12);
    pt.hovered = b; pt.onPanel = !!hit && !b;
    pt.ray.scale.z = hit ? hit.distance : 2;
    pt.dot.visible = !!hit; if (hit) pt.dot.position.copy(hit.point);
    if (b) hovered.add(b);

    const gp = pt.source.gamepad;
    if (gp) {
      const B = i => !!gp.buttons[i]?.pressed;
      const edge = i => B(i) && !pt.prev[i];
      if (B(4)) ptt = true;                          // A / X hold: talk
      if (edge(5)) ask('', { forceImage: true });    // B / Y: what's this?
      if (edge(3)) needsRecenter = true;              // stick click: recenter
      const ay = gp.axes[3] || 0;
      if (Math.abs(ay) > 0.5) scrollY = ay;
      pt.prev = gp.buttons.map(x => x.pressed);
    }
  }
  for (const b of vr.buttons) { const h = hovered.has(b); if (h !== b.hover) { b.hover = h; b.draw(); } }
  if (ptt !== pttHeld) { pttHeld = ptt; ptt ? (ensureAudioCtx(), startRecording()) : stopRecording(); }
  if (scrollY) {
    scrollAcc += -scrollY * dt * 10;
    const n = Math.trunc(scrollAcc);
    if (n) { scroll = Math.max(0, scroll + n); scrollAcc -= n; panelDirty = true; }
  } else scrollAcc = 0;
}

function frame(time) {
  const dt = Math.min(0.1, (time - lastT) / 1000 || 0); lastT = time;
  if (needsRecenter && renderer.xr.isPresenting) {
    const cam = renderer.xr.getCamera();
    cam.getWorldPosition(v1);
    if (v1.lengthSq() > 0) { recenter(); needsRecenter = false; }
  }
  updateInput(dt);
  if (busy && time - lastDots > 400) { dots++; lastDots = time; panelDirty = true; }
  if (panelDirty) { panelDirty = false; drawPanel(); }
  renderer.render(scene, camera);
}

/* ---------- enter / exit ---------- */
async function enterXR(mode) {
  ensureAudioCtx();
  try { await ensureMic(); } catch {}
  if (!vr) buildVR();
  const session = await navigator.xr.requestSession(mode, {
    requiredFeatures: ['local-floor'], optionalFeatures: ['hand-tracking'],
  });
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  const ar = mode === 'immersive-ar';
  vr.env.visible = !ar;
  renderer.setClearColor(0x000000, ar ? 0 : 1);
  renderer.domElement.style.display = 'block';
  needsRecenter = true; panelDirty = true;
  vr.relabel(); updateCamUI();
  renderer.setAnimationLoop(frame);
  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    renderer.domElement.style.display = 'none';
    if (wantRec) cancelRecording();
    pttHeld = false;
  });
}

let xrSupport = { vr: false, ar: false, reason: '' };
function updateXRNote() {
  const n = $('xr-note');
  if (!n) return;
  n.textContent = xrSupport.reason ? t(xrSupport.reason) : t('hints');
}
async function setupXR() {
  if (!window.isSecureContext) xrSupport.reason = 'insecure';
  else if (!navigator.xr) xrSupport.reason = 'noXR';
  else {
    const [v, a] = await Promise.all([
      navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
      navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
    ]);
    xrSupport = { vr: v, ar: a, reason: v || a ? '' : 'noHeadset' };
  }
  $('enter-vr').disabled = !xrSupport.vr;
  $('enter-ar').disabled = !xrSupport.ar;
  const go = mode => enterXR(mode).catch(e => setStatus(t('error') + ': ' + e.message, true));
  $('enter-vr').onclick = () => go('immersive-vr');
  $('enter-ar').onclick = () => go('immersive-ar');
  updateXRNote();
}

/* ================= boot ================= */
bindSettings();
bindChat();
applyLang();
setupXR();
document.fonts?.ready.then(() => { panelDirty = true; vr?.relabel(); });
addEventListener('resize', () => { if (!renderer.xr.isPresenting) renderer.setSize(innerWidth, innerHeight); });

// test hook
window.__questai = { S, msgs, ask, buildVR: () => { if (!vr) buildVR(); drawPanel(); return vr.panel.c.toDataURL(); } };
