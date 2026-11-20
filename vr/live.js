// "Jarvis mode": a Gemini Live (BidiGenerateContent) session over a WebSocket.
// Microphone audio (16 kHz PCM) and camera frames stream in continuously; Gemini answers with
// low-latency speech (24 kHz PCM) plus transcripts of both sides. Server-side voice detection
// decides when the user finished speaking, and the user can interrupt the reply.

const strip = ({ slow, ...t }) => t;
const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class GeminiLive {
  /**
   * on: { inText(text), outText(text), turnDone(), interrupted(), closed(reason) }
   */
  constructor({ key, model, system, voice = 'Charon', ctx, log = () => {}, on = {}, tools = [], tuned = true, resume = null, lang = '' }) {
    Object.assign(this, { key, model, system, voice, ctx, log, on, tools, tuned, resume, lang });
    this.ws = null; this.ready = false;
    this.pending = new Int16Array(0);
    this.sources = new Set(); this.playEnd = 0;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256;
    this.gain = ctx.createGain(); this.gain.connect(this.analyser); this.analyser.connect(ctx.destination);
    this.lastIn = 0; this.waiting = false;
  }

  get playing() { return this.ctx.currentTime < this.playEnd - 0.02; }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const ws = this.ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.key)}`);
      const timer = setTimeout(() => { reject(new Error('Live connection timed out')); try { ws.close(); } catch {} }, timeoutMs);
      ws.onopen = () => {
        const setup = {
          model: this.model.startsWith('models/') ? this.model : 'models/' + this.model,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          },
          systemInstruction: { parts: [{ text: this.system }] },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // without compression an audio+video session is cut after a couple of minutes
          contextWindowCompression: { slidingWindow: {} },
          sessionResumption: this.resume ? { handle: this.resume } : {},
        };
        if (this.tools.length) setup.tools = [{ functionDeclarations: this.tuned ? this.tools.map(t => t.slow ? { ...strip(t), behavior: 'NON_BLOCKING' } : strip(t)) : this.tools.map(strip) }];
        if (this.tuned) {
          // decide sooner that the user has finished speaking
          setup.realtimeInputConfig = { automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', silenceDurationMs: 500, prefixPaddingMs: 150 } };
          setup.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_MEDIUM';
          if (this.lang) setup.generationConfig.speechConfig.languageCode = this.lang;   // keeps transcripts in the user's language
        }
        ws.send(JSON.stringify({ setup }));
      };
      ws.onmessage = async ev => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : await ev.data.text()); } catch { return; }
        if (msg.setupComplete) {
          clearTimeout(timer); this.ready = true;
          this.log(`live ready (${Math.round(performance.now() - t0)}ms, ${this.model})`);
          resolve();
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => this.log('live socket error');
      ws.onclose = ev => {
        clearTimeout(timer);
        const was = this.ready; this.ready = false;
        const reason = `${ev.code}${ev.reason ? ' ' + ev.reason : ''}`;
        this.log('live closed: ' + reason);
        if (!was) reject(Object.assign(new Error(ev.reason || 'Live connection refused (' + ev.code + ')'), { code: ev.code }));
        else this.on.closed?.(reason);
      };
    });
  }

  handle(msg) {
    const sc = msg.serverContent;
    this.lastServer = performance.now();
    if (msg.goAway) { this.log('live: server will close soon'); this.on.goAway?.(); }
    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) this.on.resumeHandle?.(msg.sessionResumptionUpdate.newHandle);
    if (msg.toolCall) { this.runTools(msg.toolCall.functionCalls || []); return; }
    if (!sc) return;
    if (sc.interrupted) { this.stopPlayback(); this.on.interrupted?.(); }
    if (sc.inputTranscription?.text) { this.lastIn = performance.now(); if (!this.waiting) this.waitSince = performance.now(); this.waiting = true; this.on.inText?.(sc.inputTranscription.text); }
    if (sc.outputTranscription?.text) { this.waiting = false; this.on.outText?.(sc.outputTranscription.text); }
    for (const p of sc.modelTurn?.parts || []) {
      const d = p.inlineData || p.inline_data;
      if (d?.data && /audio/.test(d.mimeType || d.mime_type || '')) {
        this.waiting = false;
        const rate = +(/rate=(\d+)/.exec(d.mimeType || d.mime_type)?.[1] || 24000);
        this.play(d.data, rate);
      }
    }
    if (sc.turnComplete) { this.waiting = false; this.on.turnDone?.(); }
  }

  play(b64, rate) {
    const bin = atob(b64), n = bin.length >> 1;
    const buf = this.ctx.createBuffer(1, n, rate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      ch[i] = v / 0x8000;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(this.gain);
    const at = Math.max(this.ctx.currentTime + 0.03, this.playEnd);
    src.start(at); this.playEnd = at + buf.duration;
    this.sources.add(src); src.onended = () => this.sources.delete(src);
  }

  stopPlayback() {
    for (const s of this.sources) { try { s.stop(); } catch {} }
    this.sources.clear(); this.playEnd = 0;
  }

  /** Feed microphone samples. While the reply is playing only clearly louder speech goes
   *  through (barge-in), so the reply coming out of the speakers isn't heard as the user. */
  sendAudio(f32, inRate, rms) {
    if (!this.ready) return;
    if (this.playing && rms < 0.06) return;
    const ratio = inRate / 16000, n = Math.floor(f32.length / ratio);
    const out = new Int16Array(this.pending.length + n);
    out.set(this.pending);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio));
      let s = 0; for (let j = a; j < b; j++) s += f32[j];
      s = Math.max(-1, Math.min(1, s / (b - a)));
      out[this.pending.length + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    if (out.length < 1600) { this.pending = out; return; }   // send ~100 ms chunks
    this.pending = new Int16Array(0);
    this.send({ realtimeInput: { audio: { data: toB64(new Uint8Array(out.buffer)), mimeType: 'audio/pcm;rate=16000' } } });
  }

  sendFrame(dataUrl) {
    if (this.ready && dataUrl) this.send({ realtimeInput: { video: { data: dataUrl.split(',')[1], mimeType: 'image/jpeg' } } });
  }

  sendText(text) {
    if (!this.ready) return;
    this.waiting = true; this.waitSince = performance.now();
    this.send({ realtimeInput: { text } });
  }

  async runTools(calls) {
    // each call answers on its own, so a slow one never holds up the others
    for (const c of calls) this.runTool(c);
  }

  async runTool(c) {
    {
      let result;
      try { result = await this.on.tool?.(c.name, c.args || {}); }
      catch (e) { result = { error: String(e?.message || e) }; }
      this.log(`tool ${c.name}(${JSON.stringify(c.args || {}).slice(0, 80)}) → ${JSON.stringify(result).slice(0, 80)}`);
      // INTERRUPT: say the result as soon as it is ready, even mid-sentence
      const response = this.tuned ? { result: result ?? 'done', scheduling: 'INTERRUPT' } : { result: result ?? 'done' };
      this.send({ toolResponse: { functionResponses: [{ id: c.id, name: c.name, response }] } });
    }
  }

  /** A session can go half-dead: the socket stays open but nothing comes back. */
  stalled() {
    return this.ready && this.waiting && this.waitSince && performance.now() - this.waitSince > 20000 &&
      performance.now() - (this.lastServer || 0) > 20000;
  }

  send(obj) { try { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj)); } catch {} }

  level() {
    if (!this.playing) return 0;
    const a = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(a);
    let s = 0; for (const v of a) { const d = (v - 128) / 128; s += d * d; }
    return Math.min(1, Math.sqrt(s / a.length) * 5);
  }

  close() {
    this.ready = false; this.stopPlayback();
    try { this.ws?.close(); } catch {}
    try { this.analyser.disconnect(); this.gain.disconnect(); } catch {}
  }
}
