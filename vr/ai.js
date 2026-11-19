// Provider adapters. All calls go directly from the browser to the provider.
export const PROVIDERS = {
  openai:    { label: 'OpenAI (ChatGPT)',      model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic (Claude)',    model: 'claude-sonnet-5-5' },
  gemini:    { label: 'Google Gemini',         model: 'gemini-flash-latest' },
  custom:    { label: 'DeepSeek / Grok / Mistral / Groq / OpenRouter / ...', model: '' },
};

const ANTHROPIC_HEADERS = k => ({
  'x-api-key': k,
  'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true',
});
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';
const trimBase = b => (b || '').trim().replace(/\/+$/, '');

async function failure(r) {
  const txt = await r.text().catch(() => '');
  let msg = txt;
  try { const j = JSON.parse(txt); msg = j.error?.message || j.error?.type || (typeof j.error === 'string' ? j.error : '') || j.message || txt; } catch {}
  const err = new Error((msg || r.statusText || 'HTTP ' + r.status).toString().slice(0, 400));
  err.status = r.status;
  return err;
}

async function* sse(resp, signal) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try { yield JSON.parse(d); } catch {}
      }
    }
  } finally { reader.releaseLock(); }
}

const b64 = dataUrl => dataUrl.split(',')[1];

// messages: [{role:'user'|'assistant', text, image?: dataURL jpeg}]
// Only the last 2 images are sent to keep requests small and fast.
function prune(messages) {
  let keep = 2;
  return [...messages].reverse().map(m => {
    if (m.image && keep > 0) { keep--; return m; }
    return m.image ? { ...m, image: null, text: (m.text || '') + ' [image]' } : m;
  }).reverse();
}

function toOpenAI(messages, system) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of prune(messages)) {
    out.push({ role: m.role, content: m.image
      ? [{ type: 'text', text: m.text }, { type: 'image_url', image_url: { url: m.image } }]
      : m.text });
  }
  return out;
}
function toAnthropic(messages) {
  return prune(messages).map(m => ({ role: m.role, content: m.image
    ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(m.image) } }, { type: 'text', text: m.text }]
    : m.text }));
}
function toGemini(messages) {
  return prune(messages).map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.image ? [{ inline_data: { mime_type: 'image/jpeg', data: b64(m.image) } }, { text: m.text }] : [{ text: m.text }],
  }));
}

/** Streams a reply. Calls onDelta(textSoFar). Returns the full text. */
export async function chat({ provider, key, model, base, system, messages, signal, onDelta }) {
  let full = '';
  const push = s => { if (s) { full += s; onDelta?.(full); } };

  if (provider === 'openai' || provider === 'custom') {
    const url = (provider === 'openai' ? 'https://api.openai.com/v1' : trimBase(base)) + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, stream: true, messages: toOpenAI(messages, system) }),
    });
    if (!r.ok) throw await failure(r);
    for await (const ev of sse(r, signal)) push(ev.choices?.[0]?.delta?.content);
    return full;
  }

  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', ...ANTHROPIC_HEADERS(key) },
      body: JSON.stringify({ model, max_tokens: 2048, stream: true, ...(system ? { system } : {}), messages: toAnthropic(messages) }),
    });
    if (!r.ok) throw await failure(r);
    for await (const ev of sse(r, signal)) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') push(ev.delta.text);
      if (ev.type === 'error') throw new Error(ev.error?.message || 'stream error');
    }
    return full;
  }

  if (provider === 'gemini') {
    const r = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}), contents: toGemini(messages) }),
    });
    if (!r.ok) throw await failure(r);
    for await (const ev of sse(r, signal)) {
      for (const p of ev.candidates?.[0]?.content?.parts || []) if (!p.thought) push(p.text);
    }
    return full;
  }
  throw new Error('unknown provider');
}

/** Lists model ids — doubles as an API key test. */
export async function listModels({ provider, key, base }) {
  let r;
  if (provider === 'anthropic') r = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: ANTHROPIC_HEADERS(key) });
  else if (provider === 'gemini') r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  else r = await fetch((provider === 'openai' ? 'https://api.openai.com/v1' : trimBase(base)) + '/models', { headers: { Authorization: 'Bearer ' + key } });
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  if (provider === 'gemini') {
    return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''));
  }
  let ids = (j.data || []).map(m => m.id);
  if (provider === 'openai') ids = ids.filter(id => /^(gpt|o\d|chatgpt)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
  return ids.sort();
}

/** wav: Blob (audio/wav). */
export async function transcribe(wav, { engine, openaiKey, geminiKey, geminiModel }) {
  const useOpenAI = engine === 'openai' || (engine === 'auto' && openaiKey);
  if (useOpenAI) {
    if (!openaiKey) throw new Error('OpenAI key missing');
    const fd = new FormData();
    fd.append('file', wav, 'speech.wav');
    fd.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + openaiKey }, body: fd });
    if (!r.ok) throw await failure(r);
    return ((await r.json()).text || '').trim();
  }
  if (!geminiKey) throw new Error('Gemini key missing');
  const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(b64(fr.result)); fr.onerror = rej; fr.readAsDataURL(wav); });
  const r = await fetch(`${GEMINI}/models/${encodeURIComponent(geminiModel || 'gemini-2.5-flash')}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': geminiKey },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim in its original language. Output only the transcript, nothing else. If there is no speech, output nothing.' },
      { inline_data: { mime_type: 'audio/wav', data } },
    ] }] }),
  });
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  return (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('').trim();
}

/** Returns an mp3 Blob. */
export async function openaiSpeech(text, key, voice, signal) {
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: 'tts-1', voice: voice || 'alloy', input: text.slice(0, 4000) }),
  });
  if (!r.ok) throw await failure(r);
  return r.blob();
}

/** Gemini text-to-speech (works with a free key, low daily limits). Returns a WAV Blob. */
export async function geminiSpeech(text, key, model = 'gemini-2.5-flash-preview-tts', signal) {
  const r = await fetch(`${GEMINI}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: text.slice(0, 3000) }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    }),
  });
  if (!r.ok) throw await failure(r);
  const j = await r.json();
  const part = (j.candidates?.[0]?.content?.parts || []).find(p => p.inlineData || p.inline_data);
  const d = part?.inlineData || part?.inline_data;
  if (!d?.data) throw new Error('no audio');
  const rate = +(/rate=(\d+)/.exec(d.mimeType || d.mime_type || '')?.[1] || 24000);
  const bin = atob(d.data), pcm = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
  const h = new DataView(new ArrayBuffer(44));
  const w = (p, s) => { for (let i = 0; i < s.length; i++) h.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); h.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, rate, true); h.setUint32(28, rate * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  w(36, 'data'); h.setUint32(40, pcm.length, true);
  return new Blob([h.buffer, pcm], { type: 'audio/wav' });
}

/** True when the error means "this model id is retired / unknown". */
export function isModelGone(e) {
  const m = String(e?.message || '');
  return (e?.status === 404 || e?.status === 400) &&
    /model|not (found|available|supported)|no longer|does not exist|deprecat|retired/i.test(m);
}

const ver = id => (id.match(/\d+(\.\d+)?/g) || ['0']).map(Number);
const newestFirst = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; } return 0; };

/** Picks a sensible current model from a provider's model list. kind: 'chat' | 'tts'. */
export function pickModel(provider, ids, kind = 'chat') {
  if (!ids?.length) return null;
  if (provider === 'gemini') {
    if (kind === 'tts') return ids.filter(id => /tts/.test(id)).sort(newestFirst)[0] || null;
    if (ids.includes('gemini-flash-latest')) return 'gemini-flash-latest';
    const flash = ids.filter(id => /^gemini-[\d.]+-flash(-\d+)?$/.test(id)).sort(newestFirst);
    if (flash.length) return flash[0];
    return ids.filter(id => /flash/.test(id) && !/(lite|tts|image|live|audio|embed|thinking|exp)/.test(id)).sort(newestFirst)[0]
      || ids.filter(id => /^gemini/.test(id) && !/(tts|image|live|audio|embed)/.test(id)).sort(newestFirst)[0] || null;
  }
  if (provider === 'openai') {
    const minis = ids.filter(id => /^gpt-[\d.]+o?-mini$/.test(id)).sort(newestFirst);
    return minis[0] || ids.filter(id => /^gpt-[\d.]+o?$/.test(id)).sort(newestFirst)[0] || null;
  }
  if (provider === 'anthropic') {
    // the API lists newest models first
    return ids.find(id => /sonnet/.test(id)) || ids[0];
  }
  return null;
}
