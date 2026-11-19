import { PROVIDERS, chat, listModels, transcribe, openaiSpeech, geminiSpeech, pickModel, isModelGone } from './ai.js';
import { t as tr, BOX_INSTRUCTIONS } from './i18n.js';
import { Tracker } from './tracker.js';

const VERSION = '3.3';
let streamBroken = false; // set when this network/WebView never delivers event streams
const $ = id => document.getElementById(id);
const NATIVE = typeof window.QuestAINative !== 'undefined';

/* ================= settings ================= */
const KEY = 'questai.settings';
const DEF = {
  lang: 'ar', provider: 'gemini', models: {},
  keys: { openai: '', anthropic: '', gemini: '', custom: '' },
  customBase: 'https://openrouter.ai/api/v1',
  system: '', ttsOn: true, ttsEngine: 'auto', ttsVoice: 'nova', sttEngine: 'auto', vad: 'medium',
  camAttach: true, camDevice: '', alwaysListen: true, autoCam: true, ttsModel: '', arFov: 78, arOffX: 0, arOffY: 0,
};
function load() {
  try {
    const j = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEF, ...j, keys: { ...DEF.keys, ...(j.keys || {}) }, models: { ...(j.models || {}) } };
  } catch { return JSON.parse(JSON.stringify(DEF)); }
}
const S = load();
const AR_LAUNCH = /[#&]ar=1/.test(location.hash);
(() => {   // the native app opens AR mode in the Quest browser and passes the settings in the URL fragment
  const m = location.hash.match(/cfg=([^&]+)/);
  if (!m) return;
  try {
    const cfg = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
    Object.assign(S, cfg, { keys: { ...S.keys, ...(cfg.keys || {}) }, models: { ...S.models, ...(cfg.models || {}) } });
    localStorage.setItem('questai.settings', JSON.stringify(S));
  } catch {}
  history.replaceState(null, '', location.pathname);   // don't leave keys in the address/history
})();
if (!S.keys[S.provider]) { const p = Object.keys(PROVIDERS).find(p => S.keys[p]); if (p) S.provider = p; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch {} }
const t = (k, v) => tr(S.lang, k, v);
const modelFor = p => (S.models[p] || PROVIDERS[p].model || '').trim();
const SHORT = { openai: 'ChatGPT', anthropic: 'Claude', gemini: 'Gemini', custom: 'Custom' };
const hasAnyKey = () => Object.values(S.keys).some(Boolean);

/* ================= state ================= */
const msgs = []; // {role, text, image, boxes, err, skip, el}
let busy = false, abortCtl = null, transcribing = false, looking = false;
let statusText = '', statusErr = false;
let live = false;
let inLevel = 0, outLevel = 0;
let rev = 0; // bumps on any visible change; XR view redraws when it changes
const bump = () => { rev++; };

function setStatus(s, err = false) {
  statusText = s; statusErr = err;
  const el = $('status'); el.textContent = s; el.classList.toggle('err', err);
  bump();
}
function orbState() {
  if (rec) return 'hearing';
  if (busy && looking) return 'looking';
  if (busy || transcribing) return 'thinking';
  if (isSpeaking()) return 'speaking';
  if (live) return 'listening';
  return 'idle';
}

/* ================= diagnostics (Settings → Diagnostics) ================= */
const diag = [];
function log(msg) {
  const line = new Date().toTimeString().slice(0, 8) + '  ' + msg;
  diag.push(line); if (diag.length > 60) diag.shift();
  console.info('[diag] ' + msg);
  const el = document.getElementById('diag'); if (el) el.textContent = diag.slice().reverse().join('\n');
}

/* ================= banner (permissions, missing keys) ================= */
function showBanner(text, primary, onPrimary, secondary, onSecondary) {
  $('banner-text').textContent = text;
  const b1 = $('banner-btn'), b2 = $('banner-btn2');
  b1.textContent = primary; b1.onclick = () => { hideBanner(); onPrimary(); };
  b2.hidden = !secondary;
  if (secondary) { b2.textContent = secondary; b2.onclick = () => { hideBanner(); onSecondary(); }; }
  $('banner').hidden = false;
}
function hideBanner() { $('banner').hidden = true; }
const denied = new Set();
function permissionBanner(kind) {
  denied.add(kind);
  const text = denied.size > 1 ? t('permBoth') : t(kind === 'cam' ? 'permCam' : 'permMic');
  const retry = async () => {
    const kinds = [...denied]; denied.clear();
    if (kinds.includes('mic')) await setLive(true);
    if (kinds.includes('cam')) await camStart();
  };
  showBanner(text, t('permAllow'), retry, NATIVE ? t('permSettings') : null, () => window.QuestAINative?.openAppSettings());
}
function checkKeysBanner() {
  if (!hasAnyKey()) showBanner(t('noKeys'), t('openSettings'), openSettings);
  else if ($('banner-text').textContent === t('noKeys')) hideBanner();
}

/* ================= messages ================= */
function splitBoxes(raw) {
  const i = raw.search(/<\s*boxes/i);
  if (i < 0) return { text: raw, boxes: null };
  const m = raw.slice(i).match(/<\s*boxes\s*>([\s\S]*?)<\s*\/\s*boxes\s*>/i);
  let boxes = null;
  if (m) {
    try {
      boxes = JSON.parse(m[1].replace(/```(json)?/g, '').trim())
        .filter(b => Array.isArray(b.box) && b.box.length === 4 && b.box.every(Number.isFinite))
        .slice(0, 12);
    } catch {}
  }
  return { text: raw.slice(0, i), boxes };
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
  if (msgs.length) { log.querySelector('.empty')?.remove(); return; }
  log.innerHTML = '<div class="empty"><b></b><span></span></div>';
  log.querySelector('b').textContent = t('emptyTitle');
  log.querySelector('span').textContent = t('emptyBody');
}
function pushMsg(m) {
  msgs.push(m);
  const el = document.createElement('div');
  el.className = 'msg ' + m.role;
  const who = document.createElement('span'); who.className = 'who';
  who.textContent = m.role === 'user' ? (S.lang === 'ar' ? 'أنت' : 'You') : SHORT[S.provider];
  el.appendChild(who);
  if (m.image) {
    const th = document.createElement('div'); th.className = 'thumb';
    const img = new Image(); img.src = m.image; th.appendChild(img);
    m.thumb = th; m.imgEl = img;
    el.appendChild(th);
  }
  const txt = document.createElement('span'); txt.className = 'txt'; el.appendChild(txt);
  m.el = el; m.txtEl = txt;
  renderEmpty();
  $('log').appendChild(el);
  updateMsg(m);
}
function updateMsg(m) {
  m.txtEl.textContent = m.text;
  m.el.classList.toggle('err', !!m.err);
  m.el.classList.toggle('typing', m.role === 'assistant' && busy && m === msgs[msgs.length - 1]);
  const log = $('log'); log.scrollTop = log.scrollHeight;
  bump();
}
function removeMsg(m) { const i = msgs.indexOf(m); if (i >= 0) msgs.splice(i, 1); m.el?.remove(); renderEmpty(); bump(); }
function clearChat() { stopAll(); msgs.length = 0; $('log').innerHTML = ''; renderEmpty(); setStatus(''); tracker.clear(); setCaption(''); }

function drawThumbBoxes(m) {
  if (!m.thumb || !m.boxes?.length) return;
  const draw = () => {
    const c = document.createElement('canvas');
    c.width = m.imgEl.naturalWidth; c.height = m.imgEl.naturalHeight;
    const g = c.getContext('2d');
    m.boxes.forEach((b, i) => drawBox(g, boxRect(b.box, c.width, c.height), b.label, i, 1, c.width / 520));
    m.thumb.appendChild(c);
  };
  m.imgEl.complete ? draw() : (m.imgEl.onload = draw);
}

/* ================= model auto-resolution ================= */
// Providers retire model ids regularly. When a request fails because the model is gone,
// fetch the provider's model list, switch to a current model and retry once.
const resolving = {};
async function resolveModel(p, kind = 'chat') {
  const key = (S.keys[p] || '').trim();
  const ids = await listModels({ provider: p, key, base: S.customBase });
  const m = pickModel(p, ids, kind);
  if (!m) return null;
  if (kind === 'tts') S.ttsModel = m; else S.models[p] = m;
  save(); syncProviderUI();
  return m;
}
async function withModel(p, fn, kind = 'chat') {
  const current = kind === 'tts' ? (S.ttsModel || undefined) : modelFor(p);
  try { return await fn(current); }
  catch (e) {
    if (!isModelGone(e)) throw e;
    resolving[p + kind] ??= resolveModel(p, kind).finally(() => { delete resolving[p + kind]; });
    const m = await resolving[p + kind];
    if (!m || m === current) throw e;
    if (kind === 'chat') setStatus(t('modelSwitched', { m }));
    return fn(m);
  }
}
function friendlyError(e) {
  const st = e?.status, m = String(e?.message || e || '');
  if (e?.timeout || e?.name === 'TimeoutError') return t('errTimeout');
  if (st === 401 || st === 403 || /api key|unauthori|permission denied|invalid.*key/i.test(m)) return t('errKey');
  if (st === 429 || /quota|rate limit|resource.?exhausted/i.test(m)) return t('errQuota');
  if (isModelGone(e)) return t('errModel');
  if (e instanceof TypeError || /failed to fetch|network/i.test(m)) return t('errNet');
  const first = m.split(/(?<=[.!؟?])\s/)[0];
  return first.length > 160 ? first.slice(0, 157) + '…' : first;
}

/* ================= ask ================= */
async function ask(text, { forceImage = false } = {}) {
  text = (text || '').trim();
  if (forceImage && !camStream) {
    if (!(await camStart())) return;
    await new Promise(r => setTimeout(r, 600));
  }
  const image = camStream && !document.hidden && (forceImage || S.camAttach) ? snapshot() : null;
  if (!text && image) text = t('whatsThisQ');
  if (!text) return;

  const p = S.provider, key = (S.keys[p] || '').trim();
  if (!key) { setStatus(t('needKey', { p: PROVIDERS[p].label }), true); checkKeysBanner(); return; }
  if (busy) abortCtl?.abort();
  stopSpeaking();

  const u = { role: 'user', text, image, snapT: lastSnapT };
  const a = { role: 'assistant', text: '' };
  const ctl = new AbortController();
  abortCtl = ctl; busy = true; looking = !!image;
  pushMsg(u); pushMsg(a);
  setStatus('');
  if (image) hud.scanUntil = performance.now() + 60000;

  let spoken = 0;
  const speakReady = final => {
    if (!S.ttsOn) return;
    if (!final && ttsEngine() === 'gemini') return; // free-tier TTS has tight limits: one request per reply
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

  const hasImages = msgs.some(m => m.image && !m.skip);
  const system = (S.system.trim() || t('sysDefault')) + (hasImages ? '\n' + BOX_INSTRUCTIONS : '');
  try {
    const history = msgs.filter(m => m !== a && !m.skip && m.text).map(m => ({ role: m.role, text: m.raw || m.text, image: m.image }));
    const t0 = performance.now();
    log(`ask → ${p}/${modelFor(p)}${image ? ' + image ' + Math.round(image.length * 0.75 / 1024) + 'KB' : ''}`);
    const full = await withModel(p, model => chat({
      provider: p, key, model, base: S.customBase, system,
      messages: history, signal: ctl.signal, log: m => log(`  ${m} (${Math.round(performance.now() - t0)}ms)`),
      preferStream: !streamBroken, onStreamBroken: () => { streamBroken = true; },
      onDelta: s => {
        if (ctl.signal.aborted) return;
        looking = false;
        a.text = clean(splitBoxes(s).text); updateMsg(a); setCaption(a.text); speakReady(false);
      },
    }));
    if (ctl.signal.aborted) throw new DOMException('aborted', 'AbortError');
    const { text: body, boxes } = splitBoxes(full);
    log(`  reply done (${Math.round(performance.now() - t0)}ms, ${full.length} chars${boxes?.length ? ', ' + boxes.length + ' boxes' : ''})`);
    a.raw = full;
    a.text = clean(body) || (boxes?.length ? t('found', { n: boxes.length }) : '…');
    busy = false; looking = false; updateMsg(a); setCaption(a.text);
    if (boxes?.length && u.image) {
      u.boxes = boxes; drawThumbBoxes(u);
      showBoxes(boxes, u.imgEl, u.snapT);
    }
    speakReady(true);
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!a.text) { removeMsg(a); u.skip = true; } else { a.text += ' …'; updateMsg(a); }
    } else {
      u.skip = true; a.skip = true; a.err = true;
      a.text = friendlyError(e); updateMsg(a);
      log(`  error ${e?.status || e?.name || ''}: ${String(e?.message || e).slice(0, 160)}`);
    }
  } finally {
    if (abortCtl === ctl) { busy = false; abortCtl = null; }
    looking = false; hud.scanUntil = 0;
    a.el?.classList.remove('typing');
    bump();
    if (!isSpeaking()) hideCaptionSoon();
    resumeListening();
  }
}
function stopAll() {
  abortCtl?.abort(); abortCtl = null; busy = false;
  stopSpeaking();
  if (rec) { rec = null; pttActive = false; setMicUI(false); }
}

/* ================= caption over the viewport ================= */
let captionTimer = 0;
function setCaption(s) {
  clearTimeout(captionTimer);
  const c = $('caption');
  c.textContent = s;
  c.classList.toggle('show', !!s);
}
function hideCaptionSoon() { clearTimeout(captionTimer); captionTimer = setTimeout(() => $('caption').classList.remove('show'), 7000); }

/* ================= audio in ================= */
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
async function openPipeOrExplain(retry) {
  try { await openPipe(); return true; }
  catch (e) {
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') permissionBanner('mic', retry);
    else setStatus(t('error') + ': ' + (e?.message || e), true);
    return false;
  }
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
  // pause while we think/speak, and for a moment after speaking so the reply's tail isn't heard as speech
  if (busy || transcribing || isSpeaking() || performance.now() - speakEndAt < 700) { vad.pre = []; vad.run = 0; return; }
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
async function startRecording() {
  if (pttActive) return;
  if (!sttReady()) { setStatus(t('needSttKey'), true); return; }
  pttActive = true;
  stopSpeaking();
  if (busy) abortCtl?.abort();
  if (!(await openPipeOrExplain(startRecording))) { pttActive = false; return; }
  if (!pttActive) { closePipeIfIdle(); return; }
  rec = { chunks: [], len: 0, live: false };
  setMicUI(true);
  setStatus('');
}
function stopRecording() { if (pttActive) { pttActive = false; if (rec && !rec.live) finishRecording(); } }
async function finishRecording() {
  const r = rec; rec = null; setMicUI(false);
  if (!r || !pipe) return;
  const rate = pipe.rate;
  closePipeIfIdle();
  if (r.len < rate * (r.live ? 0.45 : 0.35)) { if (!r.live) setStatus(t('tooShort')); return; }
  transcribing = true; setStatus(t('transcribing'));
  const sttT0 = performance.now();
  try {
    const wav = encodeWav(r.chunks, r.len, rate, 16000);
    const useGemini = S.sttEngine === 'gemini' || (S.sttEngine === 'auto' && !S.keys.openai);
    const run = geminiModel => transcribe(wav, {
      engine: S.sttEngine, openaiKey: S.keys.openai.trim(), geminiKey: S.keys.gemini.trim(), geminiModel,
    });
    const text = useGemini ? await withModel('gemini', run) : await run();
    transcribing = false;
    const said = (text || '').trim();
    log(`heard (${Math.round(performance.now() - sttT0)}ms): "${said.slice(0, 60)}"`);
    // ignore noise: empty, single letters/symbols, and phrases speech models invent on silence
    if (!said || said.replace(/[^\p{L}\p{N}]/gu, '').length < 2 ||
        /^(\.|…|you|thank you\.?|thanks for watching!?|شكرا\.?|اشتركوا في القناة|ترجمة نانسي قنقر)$/i.test(said)) {
      setStatus(r.live ? '' : t('heardNothing')); resumeListening(); return;
    }
    setStatus('');
    await ask(said);
  } catch (e) {
    transcribing = false;
    setStatus(friendlyError(e), true);
    log(`stt error ${e?.status || e?.name || ''}: ${String(e?.message || e).slice(0, 160)}`);
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
async function setLive(on, { quiet = false } = {}) {
  if (on) {
    if (!sttReady()) { if (!quiet) setStatus(t('needSttKey'), true); return; }
    if (!(await openPipeOrExplain(() => setLive(true)))) return;
    live = true; vad.pre = []; vad.run = 0;
    log('listening on');
    setStatus('');
  } else {
    live = false;
    if (rec?.live) { rec = null; setMicUI(false); }
    closePipeIfIdle();
  }
  if (NATIVE) { try { window.QuestAINative.setBackgroundListening(live); } catch {} }
  updateLiveUI();
}
function resumeListening() { if (!live) closePipeIfIdle(); }

/* ================= audio out ================= */
let ttsQueue = [], ttsPlaying = false, ttsGen = 0, audioEl = null, outAnalyser = null, speakEndAt = 0;
function ttsEngine() {
  const e = S.ttsEngine;
  if (e === 'openai' && S.keys.openai) return 'openai';
  if (e === 'gemini' && S.keys.gemini) return 'gemini';
  if (e === 'auto') return S.keys.openai ? 'openai' : S.keys.gemini ? 'gemini' : 'device';
  return 'device';
}
const isSpeaking = () => ttsPlaying || ttsQueue.length > 0;
function enqueueSpeech(text) {
  text = text.replace(/[*_#`•]/g, '').trim();
  if (!text) return;
  const item = { text, gen: ttsGen };
  const eng = ttsEngine();
  if (eng === 'openai') item.blob = openaiSpeech(text, S.keys.openai.trim(), S.ttsVoice).catch(() => null);
  if (eng === 'gemini') item.blob = withModel('gemini', m => geminiSpeech(text, S.keys.gemini.trim(), m), 'tts').catch(() => null);
  ttsQueue.push(item);
  pumpSpeech();
}
async function pumpSpeech() {
  if (ttsPlaying) return;
  const item = ttsQueue.shift();
  if (!item) { if (!busy) hideCaptionSoon(); return; }
  ttsPlaying = true;
  try {
    const blob = item.blob ? await item.blob : null;
    if (item.gen === ttsGen) {
      if (blob) await playBlob(blob);
      else if (canDeviceSpeak()) await deviceSay(item.text);
      else if (!warnedNoVoice) { warnedNoVoice = true; setStatus(t('noVoice'), true); }
    }
  } catch {}
  ttsPlaying = false;
  speakEndAt = performance.now();
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
let warnedNoVoice = false;
const canDeviceSpeak = () => NATIVE ? !!window.QuestAINative.canSpeak() : 'speechSynthesis' in window;
const nativeWaiters = new Map(); let nativeId = 0;
window.questaiSpoken = id => { const f = nativeWaiters.get(id); nativeWaiters.delete(id); f?.(); };
function deviceSay(text) {
  if (NATIVE && window.QuestAINative.canSpeak()) {
    return new Promise(res => {
      const id = 'u' + (++nativeId);
      nativeWaiters.set(id, res);
      window.QuestAINative.speak(text, /[\u0600-\u06FF]/.test(text) ? 'ar' : 'en', id);
      setTimeout(() => window.questaiSpoken(id), 90000);
    });
  }
  return new Promise(res => {
    if (!('speechSynthesis' in window)) return res();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[؀-ۿ]/.test(text) ? 'ar-SA' : 'en-US';
    const voice = speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(u.lang.slice(0, 2)));
    if (voice) u.voice = voice;
    let finished = false;
    const done = () => { if (finished) return; finished = true; clearInterval(watch); res(); };
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
    const watch = setInterval(() => { if (!speechSynthesis.speaking && !speechSynthesis.pending) setTimeout(done, 300); }, 1000);
  });
}
function stopSpeaking() {
  ttsGen++; ttsQueue = [];
  if (audioEl) { audioEl.pause(); audioEl._done?.(); }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (NATIVE) { try { window.QuestAINative.stopSpeaking(); } catch {} for (const id of [...nativeWaiters.keys()]) window.questaiSpoken(id); }
}
const levelBuf = new Uint8Array(128);
function measureOut(time) {
  if (!isSpeaking()) { outLevel *= 0.85; return; }
  if (audioEl && outAnalyser) {
    outAnalyser.getByteTimeDomainData(levelBuf);
    let s = 0; for (const v of levelBuf) { const d = (v - 128) / 128; s += d * d; }
    outLevel = outLevel * 0.5 + Math.min(1, Math.sqrt(s / levelBuf.length) * 5) * 0.5;
  } else outLevel = 0.35 + 0.25 * Math.sin(time / 90) * Math.sin(time / 230);
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
    catch (e) { if (e.name === 'NotAllowedError' || !S.camDevice) throw e; s = await tryGet({}); }
  } catch (e) {
    log(`camera failed: ${e.name} ${e.message || ''}`);
    if (e.name === 'NotAllowedError' || e.name === 'SecurityError') permissionBanner('cam', camStart);
    else setStatus(t('noCam', { e: e.message || e.name }), true);
    return false;
  }
  attachStream(s, 'camera');
  log(`camera on (${s.getVideoTracks()[0]?.label || 'camera'})`);
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
  camStream = null; camVideo.srcObject = null; tracker.clear();
  updateCamUI();
}
const camToggle = () => (camStream && camKind === 'camera') ? camStop() : camStart();
const screenToggle = () => (camStream && camKind === 'screen') ? camStop() : screenStart();
const snapCanvas = document.createElement('canvas');
let lastSnapT = 0;
function snapshot() {
  const v = camVideo;
  if (!v.videoWidth) return null;
  const sc = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight));
  snapCanvas.width = Math.round(v.videoWidth * sc); snapCanvas.height = Math.round(v.videoHeight * sc);
  snapCanvas.getContext('2d').drawImage(v, 0, 0, snapCanvas.width, snapCanvas.height);
  lastSnapT = performance.now();
  return snapCanvas.toDataURL('image/jpeg', 0.75);
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
function camLabelText() { return camKind === 'screen' ? 'SCREEN · LIVE' : 'CAM · LIVE'; }
function updateCamUI() {
  const on = !!camStream;
  $('viewport').classList.toggle('on', on);
  $('cam').classList.toggle('on', on && camKind === 'camera');
  $('screen').classList.toggle('on', on && camKind === 'screen');
  $('vp-source').textContent = on ? camLabelText() : 'NO SIGNAL';
  $('vp-res').textContent = '';
  bump();
}
camVideo.addEventListener('loadedmetadata', () => { $('vp-res').textContent = `${camVideo.videoWidth}×${camVideo.videoHeight}`; });

/* ================= HUD: detection boxes + scan ================= */
const hud = { scanUntil: 0, lastT: 0 };
const hudCanvas = $('hud'), hg = hudCanvas.getContext('2d');
const tracker = new Tracker();
// The model boxes objects on the frame it saw; the tracker then follows them live.
function showBoxes(boxes, img, snapT) {
  const go = () => {
    tracker.start(boxes, img);
    if (xr?.presenting()) xr.placeBoxes(boxes, snapT, img.naturalWidth, img.naturalHeight);  // pin on the real object
  };
  img.complete ? go() : img.addEventListener('load', go, { once: true });
}
function boxRect([y0, x0, y1, x1], w, h) {
  const c = v => Math.max(0, Math.min(1000, v)) / 1000;
  return { x: c(Math.min(x0, x1)) * w, y: c(Math.min(y0, y1)) * h, w: Math.abs(c(x1) - c(x0)) * w, h: Math.abs(c(y1) - c(y0)) * h };
}
function drawBox(g, r, label, i, p, s = 1) {
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260 + i);
  const L = Math.min(r.w, r.h) * 0.22 * p + 6 * s;
  const lime = '#d4ff3f';
  g.save();
  // glass fill with a soft vertical sheen
  const sheen = g.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
  sheen.addColorStop(0, `rgba(212,255,63,${0.14 * p})`); sheen.addColorStop(1, `rgba(212,255,63,${0.03 * p})`);
  g.fillStyle = sheen; g.fillRect(r.x, r.y, r.w, r.h);
  g.strokeStyle = `rgba(212,255,63,${(0.25 + 0.2 * pulse) * p})`; g.lineWidth = 1 * s; g.strokeRect(r.x, r.y, r.w, r.h);
  g.shadowColor = 'rgba(212,255,63,.9)'; g.shadowBlur = (8 + 10 * pulse) * s;
  g.strokeStyle = lime; g.lineWidth = 3 * s; g.lineCap = 'square';
  g.beginPath();
  for (const [cx, cy, dx, dy] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1]]) {
    g.moveTo(cx, cy + dy * L); g.lineTo(cx, cy); g.lineTo(cx + dx * L, cy);
  }
  g.stroke();
  g.shadowBlur = 0;
  // centre tick
  g.strokeStyle = `rgba(212,255,63,${0.6 * p})`; g.lineWidth = 1.5 * s;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, k = 5 * s;
  g.beginPath(); g.moveTo(cx - k, cy); g.lineTo(cx + k, cy); g.moveTo(cx, cy - k); g.lineTo(cx, cy + k); g.stroke();
  if (p > 0.6 && label) {
    const tag = `${String(i + 1).padStart(2, '0')}  ${label}`;
    g.font = `500 ${13 * s}px PlexMono, Plex, monospace`;
    g.direction = /[؀-ۿ]/.test(label) ? 'rtl' : 'ltr';
    const tw = g.measureText(tag).width + 16 * s, th = 22 * s;
    const ty = r.y - th - 4 * s < 0 ? r.y + 4 * s : r.y - th - 4 * s;
    g.globalAlpha = (p - 0.6) / 0.4;
    g.fillStyle = lime; g.fillRect(r.x, ty, tw, th);
    g.fillStyle = '#0e1200'; g.textBaseline = 'middle';
    g.textAlign = g.direction === 'rtl' ? 'right' : 'left';
    g.fillText(tag, g.direction === 'rtl' ? r.x + tw - 8 * s : r.x + 8 * s, ty + th / 2 + 1 * s);
  }
  g.restore();
}
function drawHUD(now) {
  const vp = $('viewport');
  const W = vp.clientWidth, H = vp.clientHeight, dpr = Math.min(2, devicePixelRatio || 1);
  if (hudCanvas.width !== Math.round(W * dpr) || hudCanvas.height !== Math.round(H * dpr)) { hudCanvas.width = Math.round(W * dpr); hudCanvas.height = Math.round(H * dpr); }
  hg.setTransform(dpr, 0, 0, dpr, 0, 0);
  hg.clearRect(0, 0, W, H);
  if (!camStream || !camVideo.videoWidth) return;
  // object-fit: cover mapping from frame → screen
  const vw = camVideo.videoWidth, vh = camVideo.videoHeight;
  const sc = Math.max(W / vw, H / vh), ox = (W - vw * sc) / 2, oy = (H - vh * sc) / 2;

  // reticle
  hg.strokeStyle = 'rgba(255,255,255,.45)'; hg.lineWidth = 1;
  hg.beginPath(); hg.moveTo(W / 2 - 10, H / 2); hg.lineTo(W / 2 - 3, H / 2); hg.moveTo(W / 2 + 3, H / 2); hg.lineTo(W / 2 + 10, H / 2);
  hg.moveTo(W / 2, H / 2 - 10); hg.lineTo(W / 2, H / 2 - 3); hg.moveTo(W / 2, H / 2 + 3); hg.lineTo(W / 2, H / 2 + 10); hg.stroke();

  // scanning sweep while the model looks at a frame
  if (now < hud.scanUntil) {
    const y = ((now / 1400) % 1) * H;
    const grd = hg.createLinearGradient(0, y - 60, 0, y);
    grd.addColorStop(0, 'rgba(212,255,63,0)'); grd.addColorStop(1, 'rgba(212,255,63,.16)');
    hg.fillStyle = grd; hg.fillRect(0, y - 60, W, 60);
    hg.fillStyle = 'rgba(212,255,63,.85)'; hg.fillRect(0, y, W, 1.5);
    hg.fillStyle = 'rgba(212,255,63,.25)';
    for (let gx = 24; gx < W; gx += 48) for (let gy = 24; gy < H; gy += 48) hg.fillRect(gx, gy, 1.5, 1.5);
  }

  // tracked detections: follow the objects as the camera / head moves
  if (tracker.items.length) {
    tracker.update(camVideo, now);
    const dt = Math.min(0.1, (now - (hud.lastT || now)) / 1000) || 1 / 30;
    for (const b of tracker.view(dt)) {
      const age = now - b.born;
      const p = Math.min(1, Math.max(0, (age - b.i * 120) / 450));
      const ease = 1 - Math.pow(1 - p, 3);
      const sr = { x: ox + b.x * vw * sc, y: oy + b.y * vh * sc, w: b.w * vw * sc, h: b.h * vh * sc };
      const grow = (1 - ease) * 0.12;
      sr.x -= sr.w * grow / 2; sr.y -= sr.h * grow / 2; sr.w *= 1 + grow; sr.h *= 1 + grow;
      hg.globalAlpha = b.lost ? 0.3 : 1;   // lost: dim until re-acquired
      drawBox(hg, sr, b.label, b.i, ease);
    }
    hg.globalAlpha = 1;
  }
  hud.lastT = now;
}

/* ================= UI wiring ================= */
function setMicUI() { bump(); }
function updateLiveUI() {
  $('mic').classList.toggle('on', live);
  $('mic-label').textContent = live ? t('micOn') : t('micOff');
  bump();
}
const meterBars = [];
(() => { const m = $('meter'); for (let i = 0; i < 28; i++) { const b = document.createElement('i'); m.appendChild(b); meterBars.push(b); } })();
let lastState = '';
function uiFrame(now) {
  measureOut(now);
  const st = orbState();
  if (st !== lastState) {
    lastState = st;
    $('state-text').textContent = t('st_' + st);
    document.querySelector('.state').dataset.s = st;
    bump();
  }
  const lvl = st === 'hearing' || st === 'listening' ? inLevel : st === 'speaking' ? outLevel : st === 'thinking' || st === 'looking' ? 0.15 + 0.1 * Math.sin(now / 150) : 0.02;
  $('mic').style.setProperty('--lvl', inLevel.toFixed(3));
  if (!camStream) {
    $('meter').classList.toggle('on', st !== 'idle');
    meterBars.forEach((b, i) => {
      const wave = 0.5 + 0.5 * Math.sin(now / 160 + i * 0.7) * Math.sin(now / 410 + i * 0.31);
      const center = 1 - Math.abs(i - 13.5) / 14;
      b.style.height = (6 + lvl * 78 * wave * (0.35 + 0.65 * center)).toFixed(1) + 'px';
    });
  }
  drawHUD(now);
}
function loop(now) { if (!xr?.presenting()) uiFrame(now); requestAnimationFrame(loop); }

function applyLang() {
  const html = document.documentElement;
  html.lang = S.lang; html.dir = S.lang === 'ar' ? 'rtl' : 'ltr';
  document.querySelectorAll('[data-i]').forEach(el => { el.textContent = t(el.dataset.i); });
  $('lang').textContent = S.lang === 'ar' ? 'EN' : 'ع';
  $('text').placeholder = t('typePh');
  $('system').placeholder = t('sysDefault');
  lastState = '';
  if (!statusErr) setStatus('');
  renderEmpty(); updateCamUI(); updateLiveUI(); checkKeysBanner(); updateChip();
  bump();
}
function updateChip() { $('model-chip').textContent = `${SHORT[S.provider]} · ${modelFor(S.provider) || '—'}`; }
function openSettings() { $('sheet').hidden = false; }
function closeSettings() { $('sheet').hidden = true; checkKeysBanner(); autoStart(); }

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
  updateChip(); bump();
}
function cycleProvider() {
  const ids = Object.keys(PROVIDERS);
  const withKey = ids.filter(p => S.keys[p]);
  const list = withKey.length ? withKey : ids;
  S.provider = list[(list.indexOf(S.provider) + 1) % list.length];
  save(); syncProviderUI();
}
function bindSettings() {
  fillProviders(); syncProviderUI();
  $('provider').onchange = () => { S.provider = $('provider').value; save(); syncProviderUI(); };
  $('model').onchange = () => { S.models[S.provider] = $('model').value.trim(); save(); updateChip(); bump(); };
  for (const p of Object.keys(PROVIDERS)) {
    const el = $('key-' + p); el.value = S.keys[p] || '';
    el.oninput = () => { S.keys[p] = el.value.trim(); save(); bump(); };
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
  bindChk('cam-attach', 'camAttach');
  bindChk('auto-cam', 'autoCam');
  for (const [id, k] of [['ar-fov', 'arFov'], ['ar-offx', 'arOffX'], ['ar-offy', 'arOffY']]) {
    const el = $(id), out = $(id + '-v');
    el.value = S[k]; out.textContent = S[k];
    el.oninput = () => { S[k] = +el.value; out.textContent = el.value; save(); };
  }
  bindChk('always-listen', 'alwaysListen', () => { if (!S.alwaysListen && live) setLive(false); });
  $('cam-device').onchange = async () => { S.camDevice = $('cam-device').value; save(); if (camStream && camKind === 'camera') { camStop(); await camStart(); } };
  populateCams();
  $('fetch-models').onclick = async () => {
    const p = S.provider, out = $('models-status');
    out.textContent = '…'; out.style.color = '';
    try {
      const ids = await listModels({ provider: p, key: (S.keys[p] || '').trim(), base: S.customBase });
      $('models').innerHTML = ids.map(id => `<option value="${id.replace(/"/g, '&quot;')}">`).join('');
      out.textContent = t('modelsLoaded', { n: ids.length }); out.style.color = 'var(--acc)';
    } catch (e) { out.textContent = t('error') + ': ' + e.message; out.style.color = '#ff9c90'; }
  };
  $('version').textContent = VERSION + (NATIVE ? ' · app' : ' · web');
}
function bindUI() {
  $('composer').onsubmit = e => { e.preventDefault(); const v = $('text').value; $('text').value = ''; ask(v); };
  $('mic').onclick = () => { ensureAudioCtx(); setLive(!live); };
  $('cam').onclick = camToggle;
  $('cam-enable').onclick = camStart;
  $('screen').hidden = NATIVE || !navigator.mediaDevices?.getDisplayMedia || /OculusBrowser|Quest|Android/i.test(navigator.userAgent);
  $('screen').onclick = screenToggle;
  $('look').onclick = () => ask('', { forceImage: true });
  $('stop').onclick = () => { stopAll(); setStatus(t('stopped')); setCaption(''); };
  $('clear').onclick = clearChat;
  $('lang').onclick = () => { S.lang = S.lang === 'ar' ? 'en' : 'ar'; save(); applyLang(); };
  $('open-settings').onclick = openSettings;
  $('close-settings').onclick = closeSettings;
  $('sheet-scrim').onclick = closeSettings;
  addEventListener('keydown', e => { if (e.key === 'Escape' && !$('sheet').hidden) closeSettings(); });
}

/* ================= native bridge ================= */
// Android back button: close settings first.
window.questaiBack = () => { if (!$('sheet').hidden) { closeSettings(); return true; } return false; };

/* ================= PWA ================= */
if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

/* ================= WebXR (browser on Quest only; loaded lazily) ================= */
const AR_URL = 'https://miqatapp.github.io/vr/';
function openARFromApp() {
  const cfg = { keys: S.keys, provider: S.provider, models: S.models, lang: S.lang, customBase: S.customBase, system: S.system,
    ttsOn: S.ttsOn, ttsEngine: S.ttsEngine, ttsVoice: S.ttsVoice, ttsModel: S.ttsModel, sttEngine: S.sttEngine, vad: S.vad,
    camAttach: S.camAttach, arFov: S.arFov, arOffX: S.arOffX, arOffY: S.arOffY };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(cfg)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  window.QuestAINative.openUrl(AR_URL + '#ar=1&cfg=' + b64);
}
let xr = null;
async function setupXR() {
  if (NATIVE) { $('enter-ar').hidden = false; $('enter-ar').onclick = openARFromApp; return; }
  if (!navigator.xr || !window.isSecureContext) return;
  const [v, a] = await Promise.all([
    navigator.xr.isSessionSupported('immersive-vr').catch(() => false),
    navigator.xr.isSessionSupported('immersive-ar').catch(() => false),
  ]);
  if (!v && !a) return;
  $('enter-vr').hidden = !v; $('enter-ar').hidden = !a;
  if (AR_LAUNCH && a) { $('ar-gate').hidden = false; $('ar-go').onclick = () => { $('ar-gate').hidden = true; go('immersive-ar'); }; }
  const go = async mode => {
    try {
      ensureAudioCtx();
      try { await ensureMic(); } catch {}
      if (!xr) xr = await (await import('./xr.js')).createXR(core);
      await xr.enter(mode);
    } catch (e) { setStatus(t('error') + ': ' + e.message, true); }
  };
  $('enter-vr').onclick = () => go('immersive-vr');
  $('enter-ar').onclick = () => go('immersive-ar');
}
const core = {
  S, t, msgs, SHORT, modelFor, hasAnyKey, camVideo, save, uiFrame,
  get rev() { return rev; }, get busy() { return busy; }, get live() { return live; },
  get statusText() { return statusText; }, get statusErr() { return statusErr; },
  get camOn() { return !!camStream; }, get inLevel() { return inLevel; }, get outLevel() { return outLevel; },
  get recording() { return !!rec && !rec.live; },
  orbState, camLabelText, ask, setLive, startRecording, stopRecording, stopAll, clearChat, camToggle, cycleProvider,
  setStatus, ensureAudioCtx, applyLang, measureOut,
};

/* ================= boot ================= */
log(`Quest AI ${VERSION} ${NATIVE ? 'app' : 'web'} · ${navigator.userAgent.match(/(OculusBrowser|Quest[^;)]*|Android [\d.]+)/)?.[0] || ''}`);
let autoStarting = false;
bindSettings();
bindUI();
applyLang();
setupXR();
requestAnimationFrame(loop);

// Mic always listening + camera always seeing, as soon as there is a key.
// Mic first, then camera: one permission dialog at a time.
// Browsers keep audio suspended until the first tap; resume on any interaction.
['pointerdown', 'keydown', 'touchstart'].forEach(ev => addEventListener(ev, () => { if (audioCtx?.state === 'suspended') audioCtx.resume(); }, { passive: true }));
async function autoStart() {
  if (autoStarting || !hasAnyKey()) return;
  autoStarting = true;
  try {
    if (S.alwaysListen && !live && sttReady()) { ensureAudioCtx(); await setLive(true, { quiet: true }); }
    if (S.autoCam && !camStream) await camStart();
  } finally { autoStarting = false; }
}
autoStart();

// test hooks
window.__questai = { S, msgs, ask, setLive, orbState, showBoxes, tracker, get live() { return live; }, core };
