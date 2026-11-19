import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/addons/webxr/XRControllerModelFactory.js';
import { XRHandModelFactory } from 'three/addons/webxr/XRHandModelFactory.js';
import { PROVIDERS, chat, listModels, transcribe, openaiSpeech } from './ai.js';
import { t as tr } from './i18n.js';

const $ = id => document.getElementById(id);

/* ================= settings ================= */
const KEY = 'questai.settings';
const DEF = {
  lang: 'ar', provider: 'openai', models: {},
  keys: { openai: '', anthropic: '', gemini: '', custom: '' },
  customBase: 'https://openrouter.ai/api/v1',
  system: '', ttsOn: true, ttsEngine: 'auto', ttsVoice: 'nova', sttEngine: 'auto', vad: 'medium',
  camAttach: true, camDevice: '',
};
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEF, ...j, keys: { ...DEF.keys, ...(j.keys || {}) }, models: { ...(j.models || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEF)); }
}
const S = load();
if (!S.keys[S.provider]) { const p = Object.keys(PROVIDERS).find(p => S.keys[p]); if (p) S.provider = p; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
const t = (k, v) => tr(S.lang, k, v);
const modelFor = p => (S.models[p] || PROVIDERS[p].model || '').trim();
const systemPrompt = () => S.system.trim() || t('sysDefault');
const SHORT = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', custom: 'Custom' };
const hasAnyKey = () => Object.values(S.keys).some(Boolean);

/* ================= state ================= */
const msgs = []; // {role, text, image, err, skip, el, imgEl}
let busy = false, abortCtl = null, transcribing = false;
let statusText = '', statusErr = false;
let panelDirty = true;
let live = false;
let inLevel = 0, outLevel = 0;

function setStatus(s, err = false) {
  statusText = s; statusErr = err;
  const el = $('status'); el.textContent = s; el.classList.toggle('err', err);
  panelDirty = true;
}

function orbState() {
  if (rec) return 'hearing';
  if (busy || transcribing) return 'thinking';
  if (isSpeaking()) return 'speaking';
  if (live) return 'listening';
  return 'idle';
}

/* ================= messages ================= */
function clean(s) {
  return (s || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}
const escapeHtml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function renderEmpty() {
  const log = $('log');
  if (!msgs.length) log.innerHTML = `<div class="empty">${escapeHtml(t('empty'))}</div>`;
  else log.querySelector('.empty')?.remove();
}
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
  m.el.classList.toggle('typing', m.role === 'assistant' && busy && !!abortCtl && m === msgs[msgs.length - 1]);
  m._wrapKey = null;
  const log = $('log'); log.scrollTop = log.scrollHeight;
  panelDirty = true;
}
function removeMsg(m) { const i = msgs.indexOf(m); if (i >= 0) msgs.splice(i, 1); m.el?.remove(); renderEmpty(); panelDirty = true; }
function clearChat() { stopAll(); msgs.length = 0; $('log').innerHTML = ''; renderEmpty(); setStatus(''); scroll = 0; }

/* ================= ask ================= */
async function ask(text, { forceImage = false } = {}) {
  text = (text || '').trim();
  if (forceImage && !camStream) {
    if (!(await camStart())) return;
    await new Promise(r => setTimeout(r, 500));
  }
  const image = camStream && (forceImage || S.camAttach) ? snapshot() : null;
  if (!text && image) text = t('whatsThisQ');
  if (!text) return;

  const p = S.provider, key = (S.keys[p] || '').trim();
  if (!key) { setStatus(t('needKey', { p: PROVIDERS[p].label }), true); return; }
  if (busy) abortCtl?.abort();
  stopSpeaking();

  const u = { role: 'user', text, image };
  const a = { role: 'assistant', text: '' };
  const ctl = new AbortController();
  abortCtl = ctl; busy = true;
  pushMsg(u); pushMsg(a);
  setStatus(t('thinking'));

  let spoken = 0;
  const speakReady = final => {
    if (!S.ttsOn) return;
    for (;;) {
      const rest = a.text.slice(spoken);
      if (final) { if (rest.trim()) enqueueSpeech(rest); spoken = a.text.length; return; }
      const min = spoken ? 60 : 25;
      const re = /[.!?؟…\n]+[\s"')\]]/g;
      let m, cut = -1;
      while ((m = re.exec(rest))) { cut = m.index + m[0].length; if (cut >= min) break; }
      if (cut < min) return;
      enqueueSpeech(rest.slice(0, cut)); spoken += cut;
    }
  };

  try {
    const history = msgs.filter(m => m !== a && !m.skip && m.text).map(m => ({ role: m.role, text: m.text, image: m.image }));
    const full = await chat({
      provider: p, key, model: modelFor(p), base: S.customBase, system: systemPrompt(),
      messages: history, signal: ctl.signal,
      onDelta: s => {
        if (ctl.signal.aborted) return;
        a.text = clean(s); updateMsg(a); if (statusText) setStatus(''); speakReady(false);
      },
    });
    if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
    a.text = clean(full) || '…';
    busy = false; updateMsg(a); setStatus('');
    speakReady(true);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!a.text) { removeMsg(a); u.skip = true; } else { a.text += ' …'; updateMsg(a); }
    } else {
      u.skip = true; a.skip = true; a.err = true;
      a.text = t('error') + ': ' + (e.message || e); updateMsg(a); setStatus('');
    }
  } finally {
    if (abortCtl === ctl) { busy = false; abortCtl = null; }
    a.el?.classList.remove('typing');
    panelDirty = true;
    resumeListening();
  }
}
function stopAll() {
  abortCtl?.abort(); abortCtl = null; busy = false;
  stopSpeaking();
  if (rec) { rec = null; pttActive = false; setMicUI(false); }
}

/* ================= audio in: mic pipeline, push-to-talk, live VAD ================= */
let audioCtx = null, micStream = null, pipe = null, rec = null, pttActive = false;
function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
async function ensureMic() {
  if (micStream && micStream.getAudioTracks().some(tk => tk.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  return micStream;
}
async function openPipe() {
  if (pipe) return pipe;
  const ctx = ensureAudioCtx();
  await ensureMic();
  if (pipe) return pipe;
  const src = ctx.createMediaStreamSource(micStream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  proc.onaudioprocess = e => onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  pipe = { src, proc, mute, rate: ctx.sampleRate };
  return pipe;
}
function closePipeIfIdle() {
  if (!pipe || live || rec) return;
  pipe.src.disconnect(); pipe.proc.disconnect(); pipe.mute.disconnect(); pipe = null;
  inLevel = 0;
}

const VAD_THR = { low: 0.035, medium: 0.02, high: 0.011 };
const vad = { noise: 0.006, pre: [], run: 0 };
function onAudio(c) {
  let sum = 0; for (let i = 0; i < c.length; i++) sum += c[i] * c[i];
  const rms = Math.sqrt(sum / c.length);
  inLevel = inLevel * 0.6 + Math.min(1, rms * 12) * 0.4;
  if (rec) {
    rec.chunks.push(c); rec.len += c.length;
    if (rec.live) {
      rec.silence = rms < rec.thr * 0.6 ? rec.silence + c.length : 0;
      if (rec.silence > pipe.rate * 0.85) { finishRecording(); return; }
    }
    if (rec.len > pipe.rate * 30) finishRecording();
    return;
  }
  if (!live) return;
  if (busy || transcribing || isSpeaking()) { vad.pre = []; vad.run = 0; return; }
  const thr = Math.max(VAD_THR[S.vad] || 0.02, vad.noise * 3.2);
  if (rms < thr) vad.noise = vad.noise * 0.97 + rms * 0.03;
  vad.pre.push(c); if (vad.pre.length > 8) vad.pre.shift();
  if (rms > thr) {
    if (++vad.run >= 3) {
      const chunks = vad.pre; vad.pre = []; vad.run = 0;
      rec = { chunks, len: chunks.reduce((n, x) => n + x.length, 0), live: true, silence: 0, thr };
      setMicUI(true);
    }
  } else vad.run = 0;
}

async function startRecording() {          // push-to-talk
  if (pttActive) return;
  if (!sttReady()) { setStatus(t('needSttKey'), true); return; }
  pttActive = true;
  stopSpeaking();
  if (busy) abortCtl?.abort();
  try { await openPipe(); } catch { pttActive = false; setStatus(t('noMic'), true); return; }
  if (!pttActive) { closePipeIfIdle(); return; } // released before the mic was ready
  rec = { chunks: [], len: 0, live: false };
  setMicUI(true);
  setStatus(t('listening'));
}
function stopRecording() { if (pttActive) { pttActive = false; if (rec && !rec.live) finishRecording(); } }

async function finishRecording() {
  const r = rec; rec = null; setMicUI(false);
  if (!r || !pipe) return;
  const rate = pipe.rate;
  closePipeIfIdle();
  if (r.len < rate * (r.live ? 0.45 : 0.35)) { if (!r.live) setStatus(t('tooShort')); return; }
  transcribing = true; setStatus(t('transcribing'));
  try {
    const text = await transcribe(encodeWav(r.chunks, r.len, rate, 16000), {
      engine: S.sttEngine, openaiKey: S.keys.openai.trim(), geminiKey: S.keys.gemini.trim(),
      geminiModel: S.provider === 'gemini' ? modelFor('gemini') : PROVIDERS.gemini.model,
    });
    transcribing = false;
    const said = (text || '').trim();
    // Whisper tends to hallucinate these on silence/noise
    if (!said || /^(\.|…|you|thank you\.?|thanks for watching!?|شكرا\.?|اشتركوا في القناة)$/i.test(said)) {
      setStatus(r.live ? '' : t('heardNothing')); resumeListening(); return;
    }
    setStatus('');
    await ask(said);
  } catch (e) {
    transcribing = false;
    setStatus(t('error') + ': ' + e.message, true);
    resumeListening();
  }
}
function sttReady() {
  const e = S.sttEngine;
  if (e === 'openai') return !!S.keys.openai;
  if (e === 'gemini') return !!S.keys.gemini;
  return !!(S.keys.openai || S.keys.gemini);
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
    const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
    let s = 0; for (let j = a; j < b && j < len; j++) s += data[j];
    s = Math.max(-1, Math.min(1, s / (b - a)));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function setLive(on) {
  if (on) {
    if (!sttReady()) { setStatus(t('needSttKey'), true); return; }
    try { await openPipe(); } catch { setStatus(t('noMic'), true); return; }
    live = true; vad.pre = []; vad.run = 0;
    setStatus('');
  } else {
    live = false;
    if (rec?.live) { rec = null; setMicUI(false); }
    closePipeIfIdle();
  }
  updateLiveUI();
}
function resumeListening() { if (!live) closePipeIfIdle(); }

/* ================= audio out: sentence-streamed speech ================= */
let ttsQueue = [], ttsPlaying = false, ttsGen = 0, audioEl = null, outAnalyser = null, browserSpeaking = false;
const ttsEngine = () => S.ttsEngine === 'auto' ? (S.keys.openai ? 'openai' : 'browser') : S.ttsEngine;
const isSpeaking = () => ttsPlaying || ttsQueue.length > 0;
function enqueueSpeech(text) {
  text = text.replace(/[*_#`•]/g, '').trim();
  if (!text) return;
  const item = { text, gen: ttsGen };
  if (ttsEngine() === 'openai' && S.keys.openai) item.blob = openaiSpeech(text, S.keys.openai.trim(), S.ttsVoice).catch(() => null);
  ttsQueue.push(item);
  pumpSpeech();
}
async function pumpSpeech() {
  if (ttsPlaying) return;
  const item = ttsQueue.shift();
  if (!item) { return; }
  ttsPlaying = true;
  try {
    const blob = item.blob ? await item.blob : null;
    if (item.gen === ttsGen) await (blob ? playBlob(blob) : browserSay(item.text));
  } catch {}
  ttsPlaying = false;
  pumpSpeech();
}
function playBlob(blob) {
  return new Promise(res => {
    const a = audioEl = new Audio(URL.createObjectURL(blob));
    const done = () => { URL.revokeObjectURL(a.src); if (audioEl === a) audioEl = null; res(); };
    a.onended = done; a.onerror = done; a._done = done;
    try {
      if (audioCtx && audioCtx.state === 'running') {
        const src = audioCtx.createMediaElementSource(a);
        if (!outAnalyser) { outAnalyser = audioCtx.createAnalyser(); outAnalyser.fftSize = 256; outAnalyser.connect(audioCtx.destination); }
        src.connect(outAnalyser);
      }
    } catch {}
    a.play().catch(done);
  });
}
function browserSay(text) {
  return new Promise(res => {
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[؀-ۿ]/.test(text) ? 'ar-SA' : 'en-US';
    const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    browserSpeaking = true;
    const done = () => { if (!browserSpeaking) return; browserSpeaking = false; res(); };
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
    const watchdog = setInterval(() => { if (!speechSynthesis.speaking && !speechSynthesis.pending) { clearInterval(watchdog); setTimeout(done, 300); } }, 1000);
  });
}
function stopSpeaking() {
  ttsGen++; ttsQueue = [];
  if (audioEl) { audioEl.pause(); audioEl._done?.(); }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
const levelBuf = new Uint8Array(128);
function measureOut(time) {
  if (!isSpeaking()) { outLevel *= 0.85; return; }
  if (audioEl && outAnalyser) {
    outAnalyser.getByteTimeDomainData(levelBuf);
    let s = 0; for (const v of levelBuf) { const d = (v - 128) / 128; s += d * d; }
    outLevel = outLevel * 0.5 + Math.min(1, Math.sqrt(s / levelBuf.length) * 5) * 0.5;
  } else {
    outLevel = 0.35 + 0.25 * Math.sin(time / 90) * Math.sin(time / 230);
  }
}

/* ================= camera / screen ================= */
let camStream = null, camKind = 'camera';
const camVideo = $('cam-video');
async function camStart() {
  const base = { width: { ideal: 1280 }, height: { ideal: 960 } };
  const tryGet = c => navigator.mediaDevices.getUserMedia({ video: { ...base, ...c }, audio: false });
  let s;
  try {
    try { s = await tryGet(S.camDevice ? { deviceId: { exact: S.camDevice } } : { facingMode: 'environment' }); }
    catch (e) { if (!S.camDevice) throw e; s = await tryGet({}); }
  } catch (e) { setStatus(t('noCam', { e: e.message || e.name }), true); return false; }
  attachStream(s, 'camera');
  populateCams();
  return true;
}
async function screenStart() {
  try { attachStream(await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 10 }, audio: false }), 'screen'); return true; }
  catch (e) { if (e.name !== 'NotAllowedError') setStatus(t('noCam', { e: e.message || e.name }), true); return false; }
}
function attachStream(s, kind) {
  camStream?.getTracks().forEach(tk => tk.stop());
  camStream = s; camKind = kind;
  camVideo.srcObject = s;
  camVideo.play().catch(() => {});
  s.getVideoTracks()[0]?.addEventListener('ended', () => { if (camStream === s) camStop(); });
  updateCamUI();
}
function camStop() {
  camStream?.getTracks().forEach(tk => tk.stop());
  camStream = null; camVideo.srcObject = null;
  updateCamUI();
}
const camToggle = () => (camStream && camKind === 'camera') ? camStop() : camStart();
const screenToggle = () => (camStream && camKind === 'screen') ? camStop() : screenStart();
const snapCanvas = document.createElement('canvas');
function snapshot() {
  const v = camVideo;
  if (!v.videoWidth) return null;
  const sc = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight));
  snapCanvas.width = Math.round(v.videoWidth * sc); snapCanvas.height = Math.round(v.videoHeight * sc);
  snapCanvas.getContext('2d').drawImage(v, 0, 0, snapCanvas.width, snapCanvas.height);
  return snapCanvas.toDataURL('image/jpeg', 0.8);
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
function camLabelText() { return (camKind === 'screen' ? t('screenLive') : t('camLive')) + (S.camAttach ? ' · ' + t('camWillAttach') : ''); }
function updateCamUI() {
  const on = !!camStream;
  $('cam-box').hidden = !on;
  $('cam-label').textContent = camLabelText();
  $('cam').textContent = on && camKind === 'camera' ? t('camOff') : t('camOn');
  $('cam').classList.toggle('on', on && camKind === 'camera');
  $('screen').classList.toggle('on', on && camKind === 'screen');
  if (vr) {
    vr.camPanel.visible = on;
    const b = vr.btn.cam; b.active = on; b.label = on ? t('camOff') : t('camOn'); b.draw();
    vr.drawCamLabel();
  }
}

/* ================= DOM wiring ================= */
function setMicUI(on) {
  const ptt = on && !rec?.live;
  $('mic').classList.toggle('on', ptt);
  if (vr) { vr.btn.mic.active = ptt; vr.btn.mic.draw(); }
}
function updateLiveUI() {
  $('live').classList.toggle('on', live);
  $('live-label').textContent = live ? t('liveStop') : t('liveStart');
  if (vr) { const b = vr.btn.live; b.active = live; b.label = live ? t('liveOff') : t('liveShort'); b.draw(); }
  panelDirty = true;
}
let lastOrb = '';
function updateOrbDOM() {
  const st = orbState();
  const orb = $('orb');
  if (st !== lastOrb) { orb.className = 'orb ' + st; $('orb-state').textContent = t('st_' + st); lastOrb = st; panelDirty = true; }
  const lvl = st === 'hearing' || st === 'listening' ? inLevel : st === 'speaking' ? outLevel : 0;
  orb.style.setProperty('--lvl', lvl.toFixed(3));
}
function domLoop(time) {
  if (renderer.xr.isPresenting) return;
  measureOut(time);
  updateOrbDOM();
  requestAnimationFrame(domLoop);
}

function applyLang() {
  const html = document.documentElement;
  html.lang = S.lang; html.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  $('lang').textContent = '🌐 ' + t('lang');
  $('text').placeholder = t('typePh');
  $('system').placeholder = t('sysDefault');
  lastOrb = '';
  renderEmpty(); updateCamUI(); updateLiveUI(); updateXRNote(); updateWelcome();
  if (vr) vr.relabel();
  panelDirty = true;
}
function updateWelcome() { $('welcome').hidden = hasAnyKey(); }
function showTab(name) {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'tab-' + name));
  document.querySelector('.tabs').classList.toggle('s2', name === 'settings');
}

function fillProviders() {
  const sel = $('provider'); sel.innerHTML = '';
  for (const [id, p] of Object.entries(PROVIDERS)) sel.add(new Option(p.label, id));
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
    el.oninput = () => { S.keys[p] = el.value.trim(); save(); updateWelcome(); panelDirty = true; };
  }
  document.querySelectorAll('.eye').forEach(b => b.onclick = () => { const i = $(b.dataset.for); i.type = i.type === 'password' ? 'text' : 'password'; });
  const bindVal = (id, k, ev = 'change') => { const el = $(id); el.value = S[k]; el.addEventListener(ev, () => { S[k] = el.value; save(); }); };
  const bindChk = (id, k, after) => { const el = $(id); el.checked = !!S[k]; el.onchange = () => { S[k] = el.checked; save(); after?.(); }; };
  bindVal('custom-base', 'customBase', 'input');
  const preset = $('custom-preset');
  preset.value = [...preset.options].some(o => o.value && o.value === S.customBase) ? S.customBase : '';
  preset.onchange = () => { if (preset.value) { S.customBase = $('custom-base').value = preset.value; save(); } };
  bindVal('system', 'system', 'input');
  bindVal('tts-engine', 'ttsEngine'); bindVal('tts-voice', 'ttsVoice'); bindVal('stt-engine', 'sttEngine'); bindVal('vad', 'vad');
  bindChk('tts-on', 'ttsOn', () => { if (!S.ttsOn) stopSpeaking(); });
  bindChk('cam-attach', 'camAttach', updateCamUI);
  $('cam-device').onchange = async () => { S.camDevice = $('cam-device').value; save(); if (camStream && camKind === 'camera') { camStop(); await camStart(); } };
  populateCams();

  $('fetch-models').onclick = async () => {
    const p = S.provider, out = $('models-status');
    out.textContent = '…'; out.style.color = '';
    try {
      const ids = await listModels({ provider: p, key: (S.keys[p] || '').trim(), base: S.customBase });
      $('models').innerHTML = ids.map(id => `<option value="${escapeHtml(id)}">`).join('');
      out.textContent = t('modelsLoaded', { n: ids.length }); out.style.color = '#2fe0a0';
    } catch (e) { out.textContent = t('error') + ': ' + e.message; out.style.color = '#ff8b9d'; }
  };
}
function bindChat() {
  $('send').onclick = () => { const v = $('text').value; $('text').value = ''; ask(v); };
  $('text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('send').click(); } });
  const mic = $('mic');
  mic.addEventListener('pointerdown', e => { e.preventDefault(); mic.setPointerCapture?.(e.pointerId); ensureAudioCtx(); startRecording(); });
  for (const ev of ['pointerup', 'pointercancel']) mic.addEventListener(ev, stopRecording);
  mic.addEventListener('contextmenu', e => e.preventDefault());
  $('live').onclick = () => { ensureAudioCtx(); setLive(!live); };
  $('cam').onclick = camToggle;
  $('screen').hidden = !navigator.mediaDevices?.getDisplayMedia || /OculusBrowser|Quest/i.test(navigator.userAgent);
  $('screen').onclick = screenToggle;
  $('snap').onclick = () => ask('', { forceImage: true });
  $('stop').onclick = () => { stopAll(); setStatus(t('stopped')); };
  $('clear').onclick = clearChat;
  $('lang').onclick = () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; save(); applyLang(); };
  $('go-settings').onclick = () => showTab('settings');
  document.querySelectorAll('.tab').forEach(b => b.onclick = () => showTab(b.dataset.tab));
}

/* ================= PWA ================= */
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('install').hidden = false; });
$('install').onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('install').hidden = true; };
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

/* ================= XR scene ================= */
let vr = null;
let scroll = 0;
const FONT = '"Noto Sans Arabic", system-ui, sans-serif';
const isRTL = s => /[֐-ࣿ]/.test(s);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.xr.setFoveation(0.4);
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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  return { c, g: c.getContext('2d'), tex, mesh };
}
function radialTexture(stops) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

const ORB_COLORS = {
  idle: [0x5b8cff, 0x9b6bff], listening: [0x2fe0a0, 0x1aa2ff], hearing: [0x2fe0a0, 0x36f5c4],
  thinking: [0xb07bff, 0xff5fd2], speaking: [0x33d6ff, 0x5b8cff],
};

function buildVR() {
  const ui = new THREE.Group(); scene.add(ui);

  // ---- VR-only environment: night gradient, stars, floor ----
  const env = new THREE.Group(); scene.add(env);
  env.add(new THREE.Mesh(new THREE.SphereGeometry(60, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 p; void main(){
      float h = p.y*.5+.5;
      vec3 c = mix(vec3(.01,.012,.03), vec3(.05,.06,.16), smoothstep(.3,.75,h));
      c += vec3(.25,.12,.45) * pow(max(0., 1.-abs(p.y-.05)*3.), 4.) * .35;
      gl_FragColor = vec4(c,1.); }`,
  })));
  const sp = [];
  for (let i = 0; i < 1500; i++) {
    const v = new THREE.Vector3().randomDirection(); if (v.y < 0.05) v.y = Math.abs(v.y) + 0.05;
    v.normalize().multiplyScalar(50); sp.push(v.x, v.y, v.z);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
  env.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 0.12, transparent: true, opacity: 0.8 })));
  const grid = new THREE.GridHelper(80, 80, 0x2b3d70, 0x121a33);
  grid.material.transparent = true; grid.material.opacity = 0.45; env.add(grid);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 0.93, 96), new THREE.MeshBasicMaterial({ color: 0x5b8cff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002; env.add(ring);

  // ---- main panel + glow ----
  const PW = 1.1, PH = 0.95;
  const panel = canvasPlane(PW, PH, 1400);
  ui.add(panel.mesh);
  const backGlow = new THREE.Mesh(new THREE.PlaneGeometry(PW * 1.7, PH * 1.7),
    new THREE.MeshBasicMaterial({ map: radialTexture([[0, 'rgba(91,140,255,.5)'], [1, 'rgba(91,140,255,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.45 }));
  backGlow.position.z = -0.02; ui.add(backGlow);

  // ---- AI orb ----
  const orbMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uC1: { value: new THREE.Color(0x5b8cff) }, uC2: { value: new THREE.Color(0x9b6bff) } },
    vertexShader: `uniform float uTime; uniform float uLevel; varying vec3 vN; varying vec3 vV; varying float vD;
      void main(){
        vec3 p = position;
        float n = sin(p.x*38.+uTime*2.3)*sin(p.y*33.+uTime*1.9)*sin(p.z*41.+uTime*2.7);
        p += normal*n*(.006 + uLevel*.03); vD = n;
        vec4 mv = modelViewMatrix*vec4(p,1.);
        vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uC1; uniform vec3 uC2; uniform float uLevel; varying vec3 vN; varying vec3 vV; varying float vD;
      void main(){
        float f = pow(1.-max(dot(vN,vV),0.), 2.2);
        vec3 c = mix(uC2, uC1, .5+.5*vD);
        vec3 col = c*(.45+.5*uLevel) + mix(uC1, vec3(1.), .55)*f*1.6;
        gl_FragColor = vec4(col, .62 + f*.38); }`,
  });
  const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.075, 24), orbMat);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture([[0, 'rgba(255,255,255,.9)'], [0.25, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]),
    color: 0x5b8cff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  halo.scale.setScalar(0.42);
  const orbGroup = new THREE.Group(); orbGroup.add(halo, orb);
  orbGroup.position.set(0, PH / 2 + 0.13, 0.02);
  ui.add(orbGroup);
  const orbLabel = canvasPlane(0.4, 0.045, 1400);
  orbLabel.mesh.position.set(0, PH / 2 + 0.025, 0.01);
  ui.add(orbLabel.mesh);
  let orbLabelText = '';
  const drawOrbLabel = txt => {
    if (txt === orbLabelText) return; orbLabelText = txt;
    const { g, c, tex } = orbLabel; g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = '#b9c7ea'; g.font = `500 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.direction = S.lang === 'ar' ? 'rtl' : 'ltr'; g.fillText(txt, c.width / 2, c.height / 2 + 2); tex.needsUpdate = true;
  };

  // ---- camera / screen preview ----
  const camTex = new THREE.VideoTexture(camVideo); camTex.colorSpace = THREE.SRGBColorSpace;
  const camPanel = new THREE.Group();
  const frame = canvasPlane(0.52, 0.4, 600);
  frame.g.fillStyle = 'rgba(12,16,28,.9)'; roundRect(frame.g, 0, 0, frame.c.width, frame.c.height, 26); frame.g.fill();
  frame.g.strokeStyle = 'rgba(255,79,109,.7)'; frame.g.lineWidth = 4; frame.g.stroke(); frame.tex.needsUpdate = true;
  frame.mesh.position.z = -0.002;
  const camMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.49, 0.3675), new THREE.MeshBasicMaterial({ map: camTex }));
  const camLabel = canvasPlane(0.49, 0.055, 1000);
  camLabel.mesh.position.y = 0.24;
  camPanel.add(frame.mesh, camMesh, camLabel.mesh);
  camPanel.position.set(-0.86, 0.1, 0.14); camPanel.rotation.y = 0.45;
  camPanel.visible = false;
  ui.add(camPanel);
  const drawCamLabel = () => {
    const { g, c, tex } = camLabel; g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(255,79,109,.92)'; roundRect(g, 0, 0, c.width, c.height, 26); g.fill();
    g.fillStyle = '#fff'; g.font = `600 28px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.direction = S.lang === 'ar' ? 'rtl' : 'ltr';
    g.fillText('● ' + camLabelText(), c.width / 2, c.height / 2 + 2);
    tex.needsUpdate = true;
  };

  // ---- buttons ----
  const buttons = [];
  const BH = 0.085;
  function makeButton(id, w, onPress, opts = {}) {
    const p = canvasPlane(w, BH, 1400);
    const b = { id, ...p, w, onPress, hover: false, active: false, label: '', hoverT: 0, ...opts };
    b.draw = () => {
      const { g, c, tex } = b; g.clearRect(0, 0, c.width, c.height);
      const grd = g.createLinearGradient(0, 0, c.width, c.height);
      if (b.active) { grd.addColorStop(0, '#ff4f6d'); grd.addColorStop(1, '#ff7a59'); }
      else if (b.primary) { grd.addColorStop(0, b.hover ? '#7aa3ff' : '#5b8cff'); grd.addColorStop(1, b.hover ? '#b08bff' : '#9b6bff'); }
      else { grd.addColorStop(0, b.hover ? 'rgba(70,95,160,.98)' : 'rgba(26,34,58,.94)'); grd.addColorStop(1, b.hover ? 'rgba(80,90,170,.98)' : 'rgba(32,38,70,.94)'); }
      g.fillStyle = grd; roundRect(g, 3, 3, c.width - 6, c.height - 6, (c.height - 6) / 2); g.fill();
      g.strokeStyle = b.hover ? 'rgba(200,220,255,.9)' : 'rgba(140,170,255,.25)'; g.lineWidth = 3; g.stroke();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.direction = S.lang === 'ar' ? 'rtl' : 'ltr';
      let size = 44; g.font = `600 ${size}px ${FONT}`;
      while (g.measureText(b.label).width > c.width - 50 && size > 22) { size -= 2; g.font = `600 ${size}px ${FONT}`; }
      g.fillText(b.label, c.width / 2, c.height / 2 + 3);
      tex.needsUpdate = true;
    };
    p.mesh.userData.button = b;
    ui.add(p.mesh); buttons.push(b);
    return b;
  }
  const btn = {
    live: makeButton('live', 0.25, () => { ensureAudioCtx(); setLive(!live); }, { primary: true }),
    mic: makeButton('mic', 0.25, null, { hold: true, labelKey: 'holdTalk' }),
    cam: makeButton('cam', 0.2, camToggle),
    snap: makeButton('snap', 0.22, () => ask('', { forceImage: true }), { labelKey: 'whatsThis' }),
    stop: makeButton('stop', 0.15, () => { stopAll(); setStatus(t('stopped')); }, { labelKey: 'stop' }),
    up: makeButton('up', 0.1, () => { scroll += 4; panelDirty = true; }, { fixed: '▲' }),
    down: makeButton('down', 0.1, () => { scroll = Math.max(0, scroll - 4); panelDirty = true; }, { fixed: '▼' }),
    clear: makeButton('clear', 0.15, clearChat, { labelKey: 'clear' }),
    lang: makeButton('lang', 0.16, () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; save(); applyLang(); }),
    provider: makeButton('provider', 0.21, cycleProvider),
    recenter: makeButton('recenter', 0.16, () => { needsRecenter = true; }, { labelKey: 'recenter' }),
    exit: makeButton('exit', 0.14, () => renderer.xr.getSession()?.end(), { labelKey: 'exit' }),
  };
  const rows = [['live', 'mic', 'cam', 'snap', 'stop'], ['up', 'down', 'clear', 'lang', 'provider', 'recenter', 'exit']];
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
    btn.cam.label = camStream ? t('camOff') : t('camOn'); btn.cam.active = !!camStream;
    btn.live.label = live ? t('liveOff') : t('liveShort'); btn.live.active = live;
    buttons.forEach(b => b.draw());
    drawCamLabel(); orbLabelText = '';
    layout();
    panelDirty = true;
  }

  // ---- controllers & hands ----
  const ctrlFactory = new XRControllerModelFactory();
  const handFactory = new XRHandModelFactory();
  const pointers = [];
  const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  for (let i = 0; i < 2; i++) {
    const ctrl = renderer.xr.getController(i);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xa8c4ff, transparent: true, opacity: 0.75 }));
    ray.scale.z = 2;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.008, 16, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }));
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
    ctrl.addEventListener('selectend', () => { const b = pt.pressed; pt.pressed = null; if (b?.hold) stopRecording(); });
    // grip while pointing at the panel → drag it around
    ctrl.addEventListener('squeezestart', () => { if ((pt.onPanel || pt.hovered) && !grabbedBy) { grabbedBy = pt; ctrl.attach(ui); pulse(pt, 0.5, 40); } });
    ctrl.addEventListener('squeezeend', () => { if (grabbedBy === pt) { grabbedBy = null; scene.attach(ui); levelUI(); } });
    scene.add(ctrl);
    const grip = renderer.xr.getControllerGrip(i);
    grip.add(ctrlFactory.createControllerModel(grip)); scene.add(grip);
    const hand = renderer.xr.getHand(i);
    hand.add(handFactory.createHandModel(hand, 'mesh')); scene.add(hand);
    pointers.push(pt);
  }

  vr = { ui, env, panel, PW, PH, camPanel, buttons, btn, pointers, relabel, drawCamLabel, drawOrbLabel, orb, orbMat, halo, orbGroup,
         hitTargets: [panel.mesh, ...buttons.map(b => b.mesh)] };
  relabel();
}
let grabbedBy = null;
function levelUI() {
  const head = new THREE.Vector3(); renderer.xr.getCamera().getWorldPosition(head);
  vr.ui.lookAt(head.x, vr.ui.position.y, head.z);
}

function pulse(pt, v, ms) { try { pt.source?.gamepad?.hapticActuators?.[0]?.pulse?.(v, ms); } catch {} }

function cycleProvider() {
  const ids = Object.keys(PROVIDERS);
  const withKey = ids.filter(p => S.keys[p]);
  const list = withKey.length ? withKey : ids;
  S.provider = list[(list.indexOf(S.provider) + 1) % list.length];
  save(); syncProviderUI();
}

/* ---------- panel drawing ---------- */
function wrapText(g, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const tt = line ? line + ' ' + word : word;
      if (g.measureText(tt).width > maxW && line) {
        out.push(line); line = word;
        while (g.measureText(line).width > maxW && line.length > 1) {
          let k = line.length - 1; while (k > 1 && g.measureText(line.slice(0, k)).width > maxW) k--;
          out.push(line.slice(0, k)); line = line.slice(k);
        }
      } else line = tt;
    }
    out.push(line);
  }
  return out;
}
function drawPanel() {
  const { panel: { g, c, tex } } = vr;
  const W = c.width, H = c.height;
  const rtlUI = S.lang === 'ar';
  g.clearRect(0, 0, W, H);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, 'rgba(20,26,46,.94)'); bg.addColorStop(1, 'rgba(10,13,26,.94)');
  g.fillStyle = bg; roundRect(g, 2, 2, W - 4, H - 4, 54); g.fill();
  const edge = g.createLinearGradient(0, 0, W, H);
  edge.addColorStop(0, 'rgba(91,140,255,.8)'); edge.addColorStop(1, 'rgba(155,107,255,.8)');
  g.strokeStyle = edge; g.lineWidth = 4; g.stroke();

  // header
  g.textBaseline = 'middle';
  g.direction = rtlUI ? 'rtl' : 'ltr'; g.textAlign = rtlUI ? 'right' : 'left';
  g.fillStyle = '#eef2ff'; g.font = `700 46px ${FONT}`;
  g.fillText('Quest AI', rtlUI ? W - 56 : 56, 66);
  const chipTxt = `${SHORT[S.provider]} · ${modelFor(S.provider) || '—'}`;
  g.font = `500 28px ${FONT}`; g.direction = 'ltr';
  const cw = g.measureText(chipTxt).width + 44;
  const cx = rtlUI ? 56 : W - 56 - cw;
  g.fillStyle = 'rgba(91,140,255,.16)'; roundRect(g, cx, 42, cw, 48, 24); g.fill();
  g.fillStyle = '#a9c0f2'; g.textAlign = 'center'; g.fillText(chipTxt, cx + cw / 2, 67);
  if (live) { g.fillStyle = '#ff4f6d'; g.beginPath(); g.arc(rtlUI ? cx + cw + 30 : cx - 30, 66, 11, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = 'rgba(140,170,255,.18)'; g.fillRect(48, 116, W - 96, 2);

  // messages
  const LH = 54, top = 140, bottom = H - 118, maxW = W - 180;
  const lines = [];
  for (const m of msgs) {
    const txt = m.text || (m.role === 'assistant' && busy ? '…' : '');
    if (m._wrapKey !== txt) {
      const rtl = isRTL(txt);
      g.font = `${m.role === 'user' ? 600 : 400} 38px ${FONT}`;
      g.direction = rtl ? 'rtl' : 'ltr';
      m._lines = wrapText(g, txt, maxW).map(s => ({ s, rtl }));
      m._wrapKey = txt;
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
    if (it.role === 'user' && !it.gap) { g.fillStyle = 'rgba(91,140,255,0.14)'; g.fillRect(40, y, W - 80, LH); }
    if (it.img) {
      const h = LH * 4 - 12, w = h * it.img.naturalWidth / it.img.naturalHeight;
      const x = rtlUI ? W - 72 - w : 72;
      g.save(); roundRect(g, x, y + 6, w, h, 16); g.clip(); g.drawImage(it.img, x, y + 6, w, h); g.restore();
    } else if (it.s !== undefined) {
      g.fillStyle = it.err ? '#ff9aac' : it.role === 'user' ? '#d3e1ff' : '#f1f4fb';
      g.direction = it.rtl ? 'rtl' : 'ltr'; g.textAlign = it.rtl ? 'right' : 'left';
      g.font = `${it.role === 'user' ? 600 : 400} 38px ${FONT}`;
      g.fillText(it.s, it.rtl ? W - 72 : 72, y + LH / 2);
    }
    y += LH;
  }
  if (scroll > 0) { g.fillStyle = '#8ea4d0'; g.textAlign = 'center'; g.font = `600 30px ${FONT}`; g.fillText('▼ ' + scroll, W / 2, bottom + 4); }
  if (!msgs.length) {
    g.fillStyle = '#8e9ab8'; g.textAlign = 'center'; g.direction = rtlUI ? 'rtl' : 'ltr'; g.font = `500 40px ${FONT}`;
    g.fillText(t('empty'), W / 2, (top + bottom) / 2);
    if (!hasAnyKey()) { g.fillStyle = '#ffb37a'; g.font = `500 32px ${FONT}`; g.fillText(t('settingsHint'), W / 2, (top + bottom) / 2 + 64); }
  }

  // footer
  g.fillStyle = 'rgba(140,170,255,.18)'; g.fillRect(48, H - 106, W - 96, 2);
  g.direction = rtlUI ? 'rtl' : 'ltr'; g.textAlign = 'center';
  g.fillStyle = statusErr ? '#ff8b9d' : '#bfcbea'; g.font = `500 32px ${FONT}`;
  g.fillText(statusText || ' ', W / 2, H - 70);
  g.fillStyle = '#69769a'; g.font = `400 24px ${FONT}`;
  g.fillText(t('hints'), W / 2, H - 30);
  tex.needsUpdate = true;
}

/* ---------- frame loop ---------- */
const raycaster = new THREE.Raycaster();
const tmpM = new THREE.Matrix4(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
const cA = new THREE.Color(), cB = new THREE.Color();
let needsRecenter = false, lastT = 0, scrollAcc = 0, pttHeld = false;

function recenter() {
  const cam = renderer.xr.getCamera();
  cam.getWorldPosition(v1); cam.getWorldDirection(v2);
  v2.y = 0; if (v2.lengthSq() < 1e-4) v2.set(0, 0, -1); v2.normalize();
  vr.ui.position.copy(v1).addScaledVector(v2, 1.25);
  vr.ui.position.y = Math.max(v1.y - 0.1, 0.8);
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
    const hit = grabbedBy === pt ? null : raycaster.intersectObjects(vr.hitTargets, false)[0];
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
      if (B(4)) ptt = true;                          // A / X held: push-to-talk
      if (edge(5)) ask('', { forceImage: true });    // B / Y: what's this?
      if (edge(3)) needsRecenter = true;              // stick click: recenter
      const ay = gp.axes[3] || 0;
      if (Math.abs(ay) > 0.5) scrollY = ay;
      pt.prev = gp.buttons.map(x => x.pressed);
    }
  }
  for (const b of vr.buttons) {
    const h = hovered.has(b);
    if (h !== b.hover) { b.hover = h; b.draw(); }
    b.hoverT += ((h ? 1 : 0) - b.hoverT) * Math.min(1, dt * 14);
    b.mesh.scale.setScalar(1 + b.hoverT * 0.06);
    b.mesh.position.z = 0.005 + b.hoverT * 0.012;
  }
  if (ptt !== pttHeld) { pttHeld = ptt; if (ptt) { ensureAudioCtx(); startRecording(); } else stopRecording(); }
  if (scrollY) {
    scrollAcc += -scrollY * dt * 10;
    const n = Math.trunc(scrollAcc);
    if (n) { scroll = Math.max(0, scroll + n); scrollAcc -= n; panelDirty = true; }
  } else scrollAcc = 0;
}

function updateOrb3D(time, dt) {
  const st = orbState();
  const [c1, c2] = ORB_COLORS[st];
  const k = Math.min(1, dt * 6);
  vr.orbMat.uniforms.uC1.value.lerp(cA.setHex(c1), k);
  vr.orbMat.uniforms.uC2.value.lerp(cB.setHex(c2), k);
  const lvl = st === 'hearing' || st === 'listening' ? inLevel : st === 'speaking' ? outLevel : st === 'thinking' ? 0.25 + 0.15 * Math.sin(time / 120) : 0.05;
  const u = vr.orbMat.uniforms.uLevel;
  u.value += (lvl - u.value) * Math.min(1, dt * 12);
  vr.orbMat.uniforms.uTime.value = time / 1000 * (st === 'thinking' ? 2.5 : 1);
  vr.orb.scale.setScalar(1 + u.value * 0.35 + 0.03 * Math.sin(time / 700));
  vr.halo.material.color.copy(vr.orbMat.uniforms.uC1.value);
  vr.halo.scale.setScalar(0.38 + u.value * 0.3);
  vr.orbGroup.position.y = vr.PH / 2 + 0.13 + 0.008 * Math.sin(time / 900);
  vr.drawOrbLabel(t('st_' + st));
}

function frame(time) {
  const dt = Math.min(0.1, (time - lastT) / 1000 || 0); lastT = time;
  if (needsRecenter && renderer.xr.isPresenting) {
    renderer.xr.getCamera().getWorldPosition(v1);
    if (v1.lengthSq() > 0) { recenter(); needsRecenter = false; }
  }
  updateInput(dt);
  measureOut(time);
  updateOrb3D(time, dt);
  updateOrbDOM();
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
  vr.relabel(); updateCamUI(); updateLiveUI();
  renderer.setAnimationLoop(frame);
  session.addEventListener('end', () => {
    renderer.setAnimationLoop(null);
    renderer.domElement.style.display = 'none';
    if (rec && !rec.live) { rec = null; setMicUI(false); }
    pttActive = false; pttHeld = false;
    if (grabbedBy) { scene.attach(vr.ui); grabbedBy = null; }
    requestAnimationFrame(domLoop);
  });
}

let xrSupport = { vr: false, ar: false, reason: '' };
function updateXRNote() {
  const n = $('xr-note');
  if (n) n.textContent = xrSupport.reason ? t(xrSupport.reason) : t('hints');
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
requestAnimationFrame(domLoop);
document.fonts?.ready.then(() => { panelDirty = true; vr?.relabel(); });
addEventListener('resize', () => { if (!renderer.xr.isPresenting) renderer.setSize(innerWidth, innerHeight); });

// test hooks
window.__questai = {
  S, msgs, ask, setLive, orbState, get live() { return live; },
  buildVR: () => { if (!vr) buildVR(); drawPanel(); return vr.panel.c.toDataURL(); },
  renderVR: (w = 1280, h = 900) => {
    if (!vr) buildVR();
    renderer.domElement.style.display = 'block'; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    vr.ui.position.set(0, 1.45, -1.35); camera.position.set(0, 1.5, 0); camera.lookAt(0, 1.4, -1.35);
    for (const p of vr.pointers) p.dot.visible = false;
    updateOrb3D(performance.now(), 0.016); drawPanel(); renderer.render(scene, camera);
    return renderer.domElement.toDataURL();
  },
};
