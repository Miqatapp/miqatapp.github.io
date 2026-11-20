// Lightweight on-device object tracker.
// The AI names the object and gives one box on the frame it saw; from then on each box is
// followed in the live video by normalized cross-correlation template matching on a small
// grayscale copy of the frame (no network, works for any object).

const WORK_W = 320;          // tracking resolution (width)
const TPL = 32;              // template size (longest side, in samples)
const LOCAL_R = 22, LOCAL_STEP = 3;
const SCALES_LOCAL = [0.93, 1, 1.075];
const SCALES_GLOBAL = [0.8, 1, 1.25];
const OK = 0.55, GOOD = 0.78, LOST_AFTER = 6, FORGET_MS = 9000;
// match on the object plus a margin around it: its outline against the background is often
// the only texture a plain object (black phone, white cup) has
const grow = r => ({ x: r.x - r.w * 0.15, y: r.y - r.h * 0.15, w: r.w * 1.3, h: r.h * 1.3 });

export class Tracker {
  constructor() {
    this.c = document.createElement('canvas');
    this.g = this.c.getContext('2d', { willReadFrequently: true });
    this.items = [];
    this.lastUpdate = 0;
    this.lastGlobal = 0;
  }

  clear() { this.items = []; }

  grab(src, sw, sh) {
    const W = WORK_W, H = Math.max(1, Math.round(W * sh / sw));
    if (this.c.width !== W || this.c.height !== H) { this.c.width = W; this.c.height = H; }
    this.g.drawImage(src, 0, 0, W, H);
    const d = this.g.getImageData(0, 0, W, H).data;
    const gray = new Float32Array(W * H);
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114;
    return { gray, W, H };
  }

  /** boxes: [{label, box:[ymin,xmin,ymax,xmax] 0..1000}], img: the frame the model saw. */
  start(boxes, img, now = performance.now()) {
    const f = this.grab(img, img.naturalWidth || img.videoWidth, img.naturalHeight || img.videoHeight);
    this.frameW = f.W; this.frameH = f.H;
    this.items = boxes.map((b, i) => {
      const [y0, x0, y1, x1] = b.box.map(v => Math.max(0, Math.min(1000, v)) / 1000);
      const r = { x: Math.min(x0, x1) * f.W, y: Math.min(y0, y1) * f.H, w: Math.max(4, Math.abs(x1 - x0) * f.W), h: Math.max(4, Math.abs(y1 - y0) * f.H) };
      const k = TPL / Math.max(r.w, r.h);
      const tw = Math.max(8, Math.round(r.w * k)), th = Math.max(8, Math.round(r.h * k));
      const raw = sample(f, grow(r), tw, th);
      // a plain surface (black door, white wall) has nothing to lock on to: show it, don't chase it
      let m = 0, v = 0; for (const x of raw) m += x; m /= raw.length; for (const x of raw) v += (x - m) * (x - m);
      const flat = Math.sqrt(v / raw.length) < 6;
      return { i, label: b.label, r, r0: { ...r }, sm: { ...r }, tw, th, raw, tpl: normalize(raw), score: 1, miss: 0, lost: false, lostAt: 0, born: now, global: !flat, flat };
    });
  }

  /** A fresh detection of the same objects (in the same order): move each box there and relearn its look. */
  refresh(boxes, img) {
    if (!this.items.length) return;
    const f = this.grab(img, img.naturalWidth || img.videoWidth, img.naturalHeight || img.videoHeight);
    this.items.forEach((it, k) => {
      const b = boxes[k]; if (!b) return;
      const [y0, x0, y1, x1] = b.box.map(v => Math.max(0, Math.min(1000, v)) / 1000);
      const r = { x: Math.min(x0, x1) * f.W, y: Math.min(y0, y1) * f.H, w: Math.max(4, Math.abs(x1 - x0) * f.W), h: Math.max(4, Math.abs(y1 - y0) * f.H) };
      it.r = r; it.r0 = { ...r }; it.lost = false; it.miss = 0; it.global = false;
      it.raw = sample(f, grow(r), it.tw, it.th); it.tpl = normalize(it.raw);
      if (it.flat) it.born = performance.now();   // plain objects live as long as they keep being re-detected
    });
  }

  /** Track every item in the current video frame. Throttled to ~25 fps. */
  update(video, now = performance.now()) {
    if (!this.items.length || !video.videoWidth) return;
    if (now - this.lastUpdate < 40) return;
    this.lastUpdate = now;
    const f = this.grab(video, video.videoWidth, video.videoHeight);
    this.frameW = f.W; this.frameH = f.H;
    const allowGlobal = now - this.lastGlobal > 600;
    for (const it of this.items) {
      if (it.flat) continue;
      let best;
      if (it.global || it.lost) {
        if (!allowGlobal) continue;
        this.lastGlobal = now;
        best = search(f, it, f.W / 2, f.H / 2, Math.max(f.W, f.H), 6, SCALES_GLOBAL);
        if (best) best = search(f, it, best.cx, best.cy, 8, 2, [1], best.s) || best;
        it.global = false;
      } else {
        const cx = it.r.x + it.r.w / 2, cy = it.r.y + it.r.h / 2;
        best = search(f, it, cx, cy, LOCAL_R, LOCAL_STEP, SCALES_LOCAL);
      }
      if (best) best = search(f, it, best.cx, best.cy, 3, 1, [1], best.s) || best;

      // never let a box grow or shrink far from what the model drew
      if (best && (best.r.w > it.r0.w * 1.8 || best.r.w < it.r0.w * 0.55)) best = null;
      if (best && best.score >= OK) {
        it.r = best.r; it.score = best.score; it.miss = 0;
        if (it.lost) { it.lost = false; }
        if (best.score >= GOOD) { // adapt slowly to lighting / angle changes
          const cur = sample(f, grow(best.r), it.tw, it.th);
          for (let k = 0; k < cur.length; k++) it.raw[k] = it.raw[k] * 0.9 + cur[k] * 0.1;
          it.tpl = normalize(it.raw);
        }
      } else if (++it.miss >= LOST_AFTER && !it.lost) {
        it.lost = true; it.lostAt = now;
      }
    }
    this.items = this.items.filter(it => !(it.lost && now - it.lostAt > FORGET_MS) && !(it.flat && now - it.born > 5000));
  }

  /** Smoothed rectangles in 0..1 frame coordinates for drawing. */
  view(dt = 1 / 30) {
    const a = Math.min(1, dt * 14);
    return this.items.map(it => {
      for (const k of ['x', 'y', 'w', 'h']) it.sm[k] += (it.r[k] - it.sm[k]) * a;
      return { i: it.i, label: it.label, lost: it.lost, born: it.born,
               x: it.sm.x / this.frameW, y: it.sm.y / this.frameH, w: it.sm.w / this.frameW, h: it.sm.h / this.frameH };
    });
  }
}

function sample(f, r, tw, th) {
  const out = new Float32Array(tw * th);
  const { gray, W, H } = f;
  for (let j = 0; j < th; j++) {
    const y = Math.min(H - 1, Math.max(0, Math.floor(r.y + (j + 0.5) * r.h / th)));
    for (let i = 0; i < tw; i++) {
      const x = Math.min(W - 1, Math.max(0, Math.floor(r.x + (i + 0.5) * r.w / tw)));
      out[j * tw + i] = gray[y * W + x];
    }
  }
  return out;
}

function normalize(raw) {
  let m = 0; for (const v of raw) m += v; m /= raw.length;
  const t = new Float32Array(raw.length); let n = 0;
  for (let k = 0; k < raw.length; k++) { t[k] = raw[k] - m; n += t[k] * t[k]; }
  n = Math.sqrt(n) || 1;
  for (let k = 0; k < t.length; k++) t[k] /= n;
  return t;
}

// Normalized cross-correlation of the template against a candidate rectangle.
function ncc(f, it, bx, by, bw, bh) {
  const { gray, W, H } = f, { tw, th, tpl } = it;
  if (bx < 0 || by < 0 || bx + bw > W || by + bh > H) return -1;
  const g = grow({ x: bx, y: by, w: bw, h: bh });
  const x = g.x, y = g.y, w = g.w, h = g.h;
  let s = 0, sv = 0, svv = 0;
  for (let j = 0; j < th; j++) {
    const row = Math.min(H - 1, Math.max(0, Math.floor(y + (j + 0.5) * h / th))) * W;
    for (let i = 0; i < tw; i++) {
      const v = gray[row + Math.min(W - 1, Math.max(0, Math.floor(x + (i + 0.5) * w / tw)))];
      const t = tpl[j * tw + i];
      s += t * v; sv += v; svv += v * v;
    }
  }
  const n = tw * th, varr = svv - sv * sv / n;
  if (varr < 1e-3) return -1;
  return s / Math.sqrt(varr);
}

function search(f, it, cx, cy, R, step, scales, baseScale = 1) {
  let best = null;
  for (const sc of scales) {
    const w = it.r.w * sc * baseScale, h = it.r.h * sc * baseScale;
    if (w < 6 || h < 6 || w > f.W || h > f.H) continue;
    const x0 = Math.max(0, Math.round(cx - w / 2 - R)), x1 = Math.min(f.W - w, Math.round(cx - w / 2 + R));
    const y0 = Math.max(0, Math.round(cy - h / 2 - R)), y1 = Math.min(f.H - h, Math.round(cy - h / 2 + R));
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const score = ncc(f, it, x, y, w, h);
        if (!best || score > best.score) best = { score, r: { x, y, w, h }, cx: x + w / 2, cy: y + h / 2, s: sc * baseScale };
      }
    }
  }
  if (best && baseScale !== 1) best.s = baseScale;
  return best;
}
