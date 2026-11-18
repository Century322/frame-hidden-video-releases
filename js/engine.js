/* 帧隐视频 · 网页版渲染引擎
   与桌面版 engine.py 保持同一套数学：
   - 百叶窗遮罩：pattern = (条纹索引 + 相位) * 3 % 17，阈值由遮挡强度控制
   - 相位推进：0.7~1.6 正弦摆动 × 速度（GIF 放慢 0.4）
   - 合成：仅在文字 alpha > 0 的区域内混合，性能与文字面积成正比
   - 高级效果：压印浮雕、逐个字符、字符微动、数字变形、翻页过场、防AI扰动 */

export const VIS_FRAC = 0.45;
export const VIS_K = 7;                 // int(0.45 * 17)
export const FPS = 30;
export const DURATION = 5;              // 图片背景视频时长（秒）
export const GIF_FPS = 10;
export const GIF_STRIDE = 4;
export const GIF_DURATION = 3;
export const GIF_PHASE_FACTOR = 0.4;

export const MODES = [
  ['horizontal', '水平条'],
  ['vertical', '垂直条'],
  ['diagonal', '斜向上'],
  ['diagdown', '斜向下'],
  ['crosswave', '交叉波浪'],
  ['checker', '棋盘格'],
  ['random', '随机碎片'],
  ['wave', '波浪'],
];

export const FLIP_MODES = [
  ['none', '无'],
  ['book_turn', '右翻'],
  ['book_turn_l', '左翻'],
  ['book_turn_t', '上翻'],
  ['book_turn_b', '下翻'],
  ['book_turn_br', '右下角'],
  ['book_turn_bl', '左下角'],
];

const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;

function floorMod(a, b) {
  return ((a % b) + b) % b;
}
function floorDiv(a, b) {
  return Math.floor(a / b);
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function fontStr(fs) {
  return `600 ${fs}px ${FONT_STACK}`;
}
function parseColor(color) {
  let s = String(color || '#FFFFFF').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16) || 0xFFFFFF;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* 确定性伪随机（mulberry32），同一参数每次渲染结果一致 */
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------ 文字排版 --- */
/* 英文/数字在字符间插空格增大字间距；含中文则不加（与桌面版一致） */
function spacedText(text) {
  return CJK_RE.test(text) ? text : Array.from(text).join(' ');
}

/* 自动缩字号：宽 ≤ w*maxWFrac，高 ≤ h*maxHFrac（与桌面版收敛条件一致） */
export function fitFontSize(ctx, lines, opts) {
  const { width, height, start = 300, min = 30, widthScale = 1, maxWFrac = 0.92, maxHFrac = 0.88 } = opts;
  const spaced = lines.map(spacedText);
  for (let fs = start; fs >= min; fs -= 6) {
    ctx.font = fontStr(fs);
    let maxW = 0;
    for (const ln of spaced) {
      if (!ln.trim()) continue;
      maxW = Math.max(maxW, ctx.measureText(ln).width);
    }
    const m = ctx.measureText('测');
    const ascent = m.actualBoundingBoxAscent || fs * 0.86;
    const descent = m.actualBoundingBoxDescent || fs * 0.14;
    const lineH = Math.round((ascent + descent) * 1.18);
    const totalH = lineH * spaced.length;
    if (maxW * widthScale <= width * maxWFrac && totalH <= height * maxHFrac) {
      return { fontSize: fs, lineH, spaced };
    }
  }
  ctx.font = fontStr(min);
  const m = ctx.measureText('测');
  const ascent = m.actualBoundingBoxAscent || min * 0.86;
  const descent = m.actualBoundingBoxDescent || min * 0.14;
  const lineH = Math.round((ascent + descent) * 1.18);
  return { fontSize: min, lineH, spaced };
}

/* ------------------------------------------------ 浮雕/透明度 --- */
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[row + clamp(k, 0, w - 1)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / d;
      sum += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += tmp[clamp(k, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
    }
  }
  return out;
}

function maxFilter(src, w, h, r) {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const v = src[row + clamp(x + k, 0, w - 1)];
        if (v > m) m = v;
      }
      tmp[row + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = -r; k <= r; k++) {
        const v = tmp[clamp(y + k, 0, h - 1) * w + x];
        if (v > m) m = v;
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

/* 把文字层处理成压印浮雕（雕刻/凸起），与桌面版同源算法 */
export function embossCanvas(src, mode, clarity, color) {
  const w = src.width, h = src.height;
  const sctx = src.getContext('2d', { willReadFrequently: true });
  const id = sctx.getImageData(0, 0, w, h);
  const a = new Float32Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = id.data[i * 4 + 3] / 255;
  const [cr, cg, cb] = parseColor(color).map((v) => v / 255);
  const out = new ImageData(w, h);
  const c = clamp(clarity, 0, 100);

  if (mode === 'engrave') {
    const sh = new Float32Array(w * h);
    const hi = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const g = a[i];
        const g1 = a[clamp(y - 1, 0, h - 1) * w + clamp(x - 1, 0, w - 1)];
        const g2 = a[clamp(y + 1, 0, h - 1) * w + clamp(x + 1, 0, w - 1)];
        sh[i] = Math.max(0, g - g1);
        hi[i] = Math.max(0, g2 - g);
      }
    }
    const shb = boxBlur(sh, w, h, 1);
    const hib = boxBlur(hi, w, h, 1);
    const sg = 0.4 + c / 100 * 1.6;
    const hg = 0.35 + c / 100 * 1.1;
    const dil = maxFilter(a, w, h, 2);
    const stroke = new Float32Array(w * h);
    for (let i = 0; i < stroke.length; i++) stroke[i] = Math.max(0, dil[i] - a[i]);
    const stb = boxBlur(stroke, w, h, 1);
    for (let i = 0; i < a.length; i++) {
      const s = Math.min(1, shb[i] * a[i] * sg);
      const hl = Math.min(1, hib[i] * a[i] * hg);
      let r = cr * (1 - s * 0.92);
      let g = cg * (1 - s * 0.92);
      let b = cb * (1 - s * 0.92);
      r += hl * 0.95 * (1 - r);
      g += hl * 0.95 * (1 - g);
      b += hl * 0.95 * (1 - b);
      const ea = Math.min(1, (s + hl) * 0.95);
      const ba = Math.min(1, stb[i] * 0.9);
      const oa = ea + ba * (1 - ea);
      const inv = oa > 1e-5 ? 1 / oa : 0;
      out.data[i * 4] = Math.round((r * ea + ba * (1 - ea)) * inv * 255);
      out.data[i * 4 + 1] = Math.round((g * ea + ba * (1 - ea)) * inv * 255);
      out.data[i * 4 + 2] = Math.round((b * ea + ba * (1 - ea)) * inv * 255);
      out.data[i * 4 + 3] = Math.round(Math.min(1, oa) * 255);
    }
  } else {
    const magArr = new Float32Array(w * h);
    const shadeArr = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = a[y * w + clamp(x + 1, 0, w - 1)] - a[y * w + clamp(x - 1, 0, w - 1)];
        const gy = a[clamp(y + 1, 0, h - 1) * w + x] - a[clamp(y - 1, 0, h - 1) * w + x];
        magArr[i] = Math.hypot(gx, gy);
        shadeArr[i] = gx + gy;
      }
    }
    const mag = boxBlur(magArr, w, h, 1);
    const gain = 0.6 + c / 100 * 1.4;
    for (let i = 0; i < a.length; i++) {
      const shade = shadeArr[i];
      const hv = Math.max(0, shade) * gain;
      const sv = Math.max(0, -shade) * gain;
      const r = cr * hv + cr * 0.4 * sv;
      const g = cg * hv + cg * 0.4 * sv;
      const b = cb * hv + cb * 0.4 * sv;
      out.data[i * 4] = Math.round(clamp(r, 0, 1) * 255);
      out.data[i * 4 + 1] = Math.round(clamp(g, 0, 1) * 255);
      out.data[i * 4 + 2] = Math.round(clamp(b, 0, 1) * 255);
      out.data[i * 4 + 3] = Math.round(clamp(mag[i], 0, 1) * 255);
    }
  }

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').putImageData(out, 0, 0);
  return cv;
}

export function applyOpacity(src, op) {
  if (op >= 0.999) return src;
  const w = src.width, h = src.height;
  const ctx = src.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, w, h);
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = Math.round(id.data[i] * op);
  ctx.putImageData(id, 0, 0);
  return src;
}

/* ------------------------------------------------ 数字变形 --- */
function gridSample(arr, gx, gy, u, v) {
  const fx = u * (gx - 1), fy = v * (gy - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(gx - 1, x0 + 1), y1 = Math.min(gy - 1, y0 + 1);
  const tx = fx - x0, ty = fy - y0;
  return arr[y0 * gx + x0] * (1 - tx) * (1 - ty)
    + arr[y0 * gx + x1] * tx * (1 - ty)
    + arr[y1 * gx + x0] * (1 - tx) * ty
    + arr[y1 * gx + x1] * tx * ty;
}

function sampleRGBA(data, w, h, x, y, out, oi) {
  const cx = clamp(x, 0, w - 1), cy = clamp(y, 0, h - 1);
  const x0 = Math.floor(cx), y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const tx = cx - x0, ty = cy - y0;
  for (let c = 0; c < 4; c++) {
    const v00 = data[(y0 * w + x0) * 4 + c];
    const v10 = data[(y0 * w + x1) * 4 + c];
    const v01 = data[(y1 * w + x0) * 4 + c];
    const v11 = data[(y1 * w + x1) * 4 + c];
    out[oi + c] = v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty)
      + v01 * (1 - tx) * ty + v11 * tx * ty;
  }
}

/* 把单个数字字形扭曲成“人眼可读、机器难 OCR”的形态（确定性） */
export function warpDigit(src, seed, amp = 9) {
  const w = src.width, h = src.height;
  const rng = mulberry32(seed);
  const shear = rng() * 0.84 - 0.42;
  const sx = 0.8 + rng() * 0.4;
  const sy = 0.82 + rng() * 0.36;
  const rot = rng() * 0.4 - 0.2;
  const cx = w / 2, cy = h / 2;
  const ca = Math.cos(rot), sa = Math.sin(rot);
  const a11 = ca * sx, a12 = ca * shear * sy - sa * sy;
  const a21 = sa * sx, a22 = sa * shear * sy + ca * sy;
  const e = cx - a11 * cx - a12 * cy;
  const f = cy - a21 * cx - a22 * cy;

  const dst = document.createElement('canvas');
  dst.width = w; dst.height = h;
  const dctx = dst.getContext('2d', { willReadFrequently: true });
  dctx.setTransform(a11, a21, a12, a22, e, f);
  dctx.drawImage(src, 0, 0);
  dctx.setTransform(1, 0, 0, 1, 0, 0);

  if (amp > 0 && w >= 8 && h >= 8) {
    const warped = dctx.getImageData(0, 0, w, h);
    const r2 = mulberry32(seed + 7);
    const gx = 6, gy = 6;
    const dxs = new Float32Array(gx * gy);
    const dys = new Float32Array(gx * gy);
    for (let i = 0; i < dxs.length; i++) {
      dxs[i] = r2() * 2 - 1;
      dys[i] = r2() * 2 - 1;
    }
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
      const v = h > 1 ? y / (h - 1) : 0;
      for (let x = 0; x < w; x++) {
        const u = w > 1 ? x / (w - 1) : 0;
        const dx = gridSample(dxs, gx, gy, u, v) * amp;
        const dy = gridSample(dys, gx, gy, u, v) * amp;
        sampleRGBA(warped.data, w, h, x + dx, y + dy, out.data, (y * w + x) * 4);
      }
    }
    dctx.putImageData(out, 0, 0);
  }
  return dst;
}

/* ------------------------------------------------ 逐字符文字层 --- */
function makeCharLayer(mctx, ch, fs, color, widthScale, pad, embossMode, clarity, opacity) {
  mctx.font = fontStr(fs);
  const adv = mctx.measureText(ch).width * widthScale;
  const w = Math.max(6, Math.ceil(adv) + pad * 2);
  const h = Math.max(6, Math.ceil(fs * 1.45) + pad * 2);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.font = fontStr(fs);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (Math.abs(widthScale - 1) > 0.001) {
    ctx.translate(w / 2, h / 2);
    ctx.scale(widthScale, 1);
    ctx.fillText(ch, 0, 0);
  } else {
    ctx.fillText(ch, w / 2, h / 2);
  }
  let out = cv;
  if (embossMode !== 'none') out = embossCanvas(cv, embossMode, clarity, color);
  else if (opacity < 0.999) applyOpacity(cv, opacity);
  return { canvas: out, adv };
}

/* 渲染多行文字，返回逐字符图层（绝对坐标） */
export function renderTextScene(lines, opts) {
  const {
    width, height, fontSize = 170, color = '#FFFFFF', widthScale = 1,
    opacity = 1, embossMode = 'none', embossClarity = 50,
    digitDeform = false, scale = 1,
  } = opts;
  const mcv = document.createElement('canvas');
  const mctx = mcv.getContext('2d');
  const fitted = fitFontSize(mctx, lines, { width, height, start: fontSize, widthScale });
  const fs = fitted.fontSize;
  const lineH = fitted.lineH;
  const spaced = fitted.spaced;
  const chars = [];
  const totalH = lineH * spaced.length;
  const startY = Math.floor(height / 2 - totalH / 2 + lineH / 2);
  const pad = 10 + (embossMode !== 'none' ? 6 : 0) + (digitDeform ? 24 : 0);

  for (let i = 0; i < spaced.length; i++) {
    const line = spaced[i];
    const orig = lines[i] !== undefined ? lines[i] : line;
    if (!line.trim()) continue;
    const origChars = Array.from(orig);
    mctx.font = fontStr(fs);
    const lineW = mctx.measureText(line).width * widthScale;
    let x = width / 2 - lineW / 2;
    let oi = 0;
    for (const ch of line) {
      const adv = mctx.measureText(ch).width * widthScale;
      if (ch.trim()) {
        while (oi < origChars.length && !origChars[oi].trim()) oi++;
        const oc = oi < origChars.length ? origChars[oi] : ch;
        oi++;
        const layer = makeCharLayer(mctx, oc, fs, color, widthScale, pad,
          embossMode, embossClarity, opacity);
        if (digitDeform && /\p{Nd}/u.test(oc)) {
          layer.canvas = warpDigit(layer.canvas, oc.codePointAt(0) * 131 + i * 17 + 7, 9 * scale);
        }
        chars.push({
          canvas: layer.canvas,
          x: x + adv / 2 - layer.canvas.width / 2,
          y: startY + i * lineH - layer.canvas.height / 2,
          ch: oc,
        });
      }
      x += adv;
    }
  }
  return { chars, fontSize: fs, lineH, spaced, width, height };
}

/* ------------------------------------------------ 百叶窗遮罩 --- */
export function maskThreshold(occlusion) {
  const occ = Math.max(0, Math.min(1, occlusion));
  return Math.max(1, Math.round(VIS_K * (1 - occ * 0.15)));
}

/* 每帧预计算的辅助量（波浪类模式需要）；scale 为预览降采样比例 */
export function prepareFrame(mode, phase, stripeH, occlusion, w, h, scale = 1) {
  const occFactor = 1 - Math.max(0, Math.min(1, occlusion)) * 0.15;
  const pre = {
    mode, phase, stripeH, scale, waveAmp: 18 * scale,
    threshold: maskThreshold(occlusion), occFactor, colWave: null, blocks: null,
  };
  if (mode === 'checker') {
    pre.checkerThreshold = Math.max(1, Math.round(2 * occFactor));
  } else if (mode === 'crosswave') {
    const t = Math.max(1, Math.round(VIS_K * (1 - occlusion * 0.15) * 0.3));
    pre.t = t;
    const freq = 2 * Math.PI / Math.max(120 * scale, stripeH * 8);
    const amp = stripeH * 2.0;
    const w1 = new Float32Array(w), w2 = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      w1[x] = amp * Math.sin(x * freq + phase);
      w2[x] = amp * Math.sin(-x * freq + phase * 0.8);
    }
    pre.colWave = { w1, w2 };
  } else if (mode === 'wave') {
    const pw = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      pw[x] = x / (35 / scale) + phase * 0.5;
    }
    pre.colWave = { pw };
  } else if (mode === 'random') {
    const block = stripeH * 2;
    const bh = Math.floor(h / block) + 1, bw = Math.floor(w / block) + 1;
    const frac = Math.max(0.15, VIS_FRAC * (1 - occlusion * 0.15));
    const blocks = new Uint8Array(bh * bw);
    const rand = mulberry32(Math.floor(phase / 3) + 12345);
    for (let i = 0; i < blocks.length; i++) blocks[i] = rand() < frac ? 1 : 0;
    pre.blocks = { arr: blocks, block, bw };
  }
  return pre;
}

/* 单像素可见性（热路径，只对文字 bbox 内的像素调用） */
export function isVisible(pre, x, y) {
  const { mode, phase, stripeH, threshold } = pre;
  switch (mode) {
    case 'vertical':
      return floorMod((floorDiv(x, stripeH) + phase) * 3, 17) < threshold;
    case 'diagonal':
      return floorMod((floorDiv(x + y, stripeH + 1) + phase) * 3, 17) < threshold;
    case 'diagdown':
      return floorMod((floorDiv(x - y, stripeH + 1) + phase) * 3, 17) < threshold;
    case 'checker': {
      const block = stripeH * 2;
      const p = floorMod(floorDiv(y, block) + floorDiv(x, block) + Math.floor(phase), 4);
      return p < pre.checkerThreshold;
    }
    case 'random': {
      const { arr, block, bw } = pre.blocks;
      return arr[floorDiv(y, block) * bw + floorDiv(x, block)] === 1;
    }
    case 'crosswave': {
      const { w1, w2 } = pre.colWave;
      const p1 = floorMod((floorDiv(y + w1[x], stripeH) + phase) * 3, 17);
      const p2 = floorMod((floorDiv(y + w2[x], stripeH) + phase) * 3, 17);
      return p1 < pre.t || p2 < pre.t;
    }
    case 'wave': {
      const { pw } = pre.colWave;
      const idx = floorDiv(y + Math.round(Math.sin(pw[x]) * pre.waveAmp), stripeH);
      return floorMod((idx + phase) * 3, 17) < threshold;
    }
    default:  // horizontal
      return floorMod((floorDiv(y, stripeH) + phase) * 3, 17) < threshold;
  }
}

/* ------------------------------------------------ 相位推进 --- */
export function advancePhase(phase, fc, speed, isGif) {
  let spd = (0.7 + 0.9 * (0.5 + 0.5 * Math.sin(2 * Math.PI * fc / 60))) * speed;
  if (isGif) spd *= GIF_PHASE_FACTOR;
  return phase + spd;
}

/* ------------------------------------------------ 帧合成 --- */
function compositeLayer(bgData, canvas, ox, oy, pre) {
  const { data, width, height } = bgData;
  ox = Math.round(ox);
  oy = Math.round(oy);
  const tw = canvas.width, th = canvas.height;
  let tdata = canvas._px;
  if (!tdata || canvas._pxW !== tw) {
    const tctx = canvas.getContext('2d', { willReadFrequently: true });
    tdata = tctx.getImageData(0, 0, tw, th);
    canvas._px = tdata;
    canvas._pxW = tw;
  }
  const t = tdata.data;
  let any = false;
  for (let ty = 0; ty < th; ty++) {
    const y = oy + ty;
    if (y < 0 || y >= height) continue;
    const rowT = ty * tw * 4;
    const rowB = y * width * 4;
    for (let tx = 0; tx < tw; tx++) {
      const ta = t[rowT + tx * 4 + 3];
      if (ta === 0) continue;
      const x = ox + tx;
      if (x < 0 || x >= width) continue;
      if (!isVisible(pre, x, y)) continue;
      const bi = rowB + x * 4;
      const ti = rowT + tx * 4;
      const a = ta / 255;
      data[bi] = data[bi] * (1 - a) + t[ti] * a;
      data[bi + 1] = data[bi + 1] * (1 - a) + t[ti + 1] * a;
      data[bi + 2] = data[bi + 2] * (1 - a) + t[ti + 2] * a;
      any = true;
    }
  }
  return any;
}

/* 把一个图层合成到整帧背景（兼容旧调用） */
export function compositeFrame(bgData, textLayer, pre) {
  return compositeLayer(bgData, textLayer.canvas, textLayer.x0, textLayer.y0, pre);
}

/* 合成选中的字符层；picks 为空则全部显示 */
export function compositeChars(bgData, chars, pre, opts = {}) {
  const { picks = null, motionAmp = 0, frameIndex = 0 } = opts;
  const n = chars.length;
  if (!n) return false;
  const list = picks && picks.length ? picks : Array.from({ length: n }, (_, i) => i);
  let any = false;
  for (let i = 0; i < list.length; i++) {
    const gi = list[i];
    const layer = chars[gi];
    if (!layer) continue;
    let dx = 0, dy = 0;
    if (motionAmp > 0) {
      dx = Math.round(motionAmp * Math.sin(2 * Math.PI * frameIndex / 41 + 1.3 * i));
      dy = Math.round(motionAmp * Math.cos(2 * Math.PI * frameIndex / 29 + 0.9 * i));
    }
    if (compositeLayer(bgData, layer.canvas, layer.x + dx, layer.y + dy, pre)) any = true;
  }
  return any;
}

/* 逐个字符：按帧号循环取 seqChars 个字符 */
export function seqPicks(n, frameIndex, totalFrames, seqSpeed, seqChars) {
  if (!n) return [];
  const k = Math.max(1, Math.min(Math.round(seqChars), n));
  const base = Math.max(2, Math.floor(totalFrames / n));
  const fpc = Math.max(2, Math.round(base / Math.max(0.2, seqSpeed)));
  const start = Math.floor(frameIndex / fpc) % n;
  return Array.from({ length: k }, (_, i) => (start + i) % n);
}

/* ------------------------------------------------ 翻页过场 --- */
/* 返回当前帧处于哪种状态：withText=false 背景，p=null 正常文字，p∈[0,1] 转场 */
export function flipSchedule(frameIndex, opts) {
  const { mode = 'none', duration = 0.5, interval = 0, fps = FPS, holdBare = 0.5 } = opts;
  if (mode === 'none' || duration <= 0) return { withText: true, p: null, mode };
  const openDur = duration, closeDur = duration;
  if (interval > 0) {
    const cyc = (frameIndex / fps) % interval;
    const remain = interval - openDur - closeDur - holdBare;
    const holdText = remain > 0 ? Math.max(0.4, remain * 0.75) : 0.4;
    if (cyc < holdBare) return { withText: false, p: null, mode };
    if (cyc < holdBare + openDur) {
      return { withText: true, p: (cyc - holdBare) / openDur, mode };
    }
    if (cyc < holdBare + openDur + holdText) return { withText: true, p: null, mode };
    if (cyc < holdBare + 2 * openDur + holdText) {
      return { withText: true, p: 1 - (cyc - holdBare - openDur - holdText) / closeDur, mode };
    }
    return { withText: false, p: null, mode };
  }
  const t = frameIndex / fps;
  if (t < holdBare) return { withText: false, p: null, mode };
  if (t < holdBare + openDur) return { withText: true, p: (t - holdBare) / openDur, mode };
  return { withText: true, p: null, mode };
}

/* 翻页转场：baseCtx 作为输出画布，bare 为纯背景，char 为背景+文字 */
export function applyTransition(baseCtx, bare, charCv, w, h, p, mode) {
  baseCtx.drawImage(charCv, 0, 0);
  if (mode === 'none') return;
  p = clamp(p, 0, 1);
  const ang = p * Math.PI / 2 * 1.06;
  if (ang >= Math.PI / 2) return;
  const c = Math.cos(ang);
  const strip = Math.max(2, Math.round(w / 320));

  if (mode === 'book_turn' || mode === 'book_turn_l') {
    const L = Math.max(0, w * c);
    if (mode === 'book_turn') {
      const x0 = Math.round(w - L);
      if (x0 > 0) {
        const g = baseCtx.createLinearGradient(Math.max(0, x0 - 48), 0, x0, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.42)');
        baseCtx.fillStyle = g;
        baseCtx.fillRect(Math.max(0, x0 - 48), 0, Math.min(48, w), h);
      }
      for (let dx = Math.max(0, x0); dx < w; dx += strip) {
        const xp = (w - (dx + strip / 2)) / c;
        const sw = Math.max(1, strip / c);
        const sx = clamp(Math.round(xp - sw / 2), 0, Math.max(0, w - 1));
        baseCtx.drawImage(bare, sx, 0, sw, h, dx, 0, strip, h);
        const light = clamp(1 - 0.3 * (xp / w) * (1 - 0.22 * (ang / (Math.PI / 2))), 0.42, 1);
        if (light < 0.999) {
          baseCtx.fillStyle = `rgba(0,0,0,${(1 - light).toFixed(3)})`;
          baseCtx.fillRect(dx, 0, strip, h);
        }
      }
      if (x0 > 0) {
        baseCtx.fillStyle = 'rgba(255,255,255,0.06)';
        baseCtx.fillRect(0, 0, x0, h);
      }
    } else {
      const x1 = Math.round(L);
      if (x1 < w) {
        const g = baseCtx.createLinearGradient(x1, 0, Math.min(w, x1 + 48), 0);
        g.addColorStop(0, 'rgba(0,0,0,0.42)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        baseCtx.fillStyle = g;
        baseCtx.fillRect(x1, 0, Math.min(48, w - x1), h);
      }
      for (let dx = 0; dx < x1; dx += strip) {
        const xp = (dx + strip / 2) / c;
        const sw = Math.max(1, strip / c);
        const sx = clamp(Math.round(xp - sw / 2), 0, Math.max(0, w - 1));
        baseCtx.drawImage(bare, sx, 0, sw, h, dx, 0, strip, h);
        const light = clamp(1 - 0.3 * (xp / w) * (1 - 0.22 * (ang / (Math.PI / 2))), 0.42, 1);
        if (light < 0.999) {
          baseCtx.fillStyle = `rgba(0,0,0,${(1 - light).toFixed(3)})`;
          baseCtx.fillRect(dx, 0, strip, h);
        }
      }
      if (x1 < w) {
        baseCtx.fillStyle = 'rgba(255,255,255,0.06)';
        baseCtx.fillRect(x1, 0, w - x1, h);
      }
    }
    return;
  }

  if (mode === 'book_turn_t' || mode === 'book_turn_b') {
    const L = Math.max(0, h * c);
    const syStrip = Math.max(2, Math.round(h / 320));
    if (mode === 'book_turn_t') {
      const y1 = Math.round(L);
      if (y1 < h) {
        const g = baseCtx.createLinearGradient(0, y1, 0, Math.min(h, y1 + 48));
        g.addColorStop(0, 'rgba(0,0,0,0.42)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        baseCtx.fillStyle = g;
        baseCtx.fillRect(0, y1, w, Math.min(48, h - y1));
      }
      for (let dy = 0; dy < y1; dy += syStrip) {
        const yp = (dy + syStrip / 2) / c;
        const sh = Math.max(1, syStrip / c);
        const sy = clamp(Math.round(yp - sh / 2), 0, Math.max(0, h - 1));
        baseCtx.drawImage(bare, 0, sy, w, sh, 0, dy, w, syStrip);
        const light = clamp(1 - 0.3 * (yp / h) * (1 - 0.22 * (ang / (Math.PI / 2))), 0.42, 1);
        if (light < 0.999) {
          baseCtx.fillStyle = `rgba(0,0,0,${(1 - light).toFixed(3)})`;
          baseCtx.fillRect(0, dy, w, syStrip);
        }
      }
      if (y1 < h) {
        baseCtx.fillStyle = 'rgba(255,255,255,0.06)';
        baseCtx.fillRect(0, y1, w, h - y1);
      }
    } else {
      const y0 = Math.round(h - L);
      if (y0 > 0) {
        const g = baseCtx.createLinearGradient(0, Math.max(0, y0 - 48), 0, y0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.42)');
        baseCtx.fillStyle = g;
        baseCtx.fillRect(0, Math.max(0, y0 - 48), w, Math.min(48, h));
      }
      for (let dy = Math.max(0, y0); dy < h; dy += syStrip) {
        const yp = (h - (dy + syStrip / 2)) / c;
        const sh = Math.max(1, syStrip / c);
        const sy = clamp(Math.round(yp - sh / 2), 0, Math.max(0, h - 1));
        baseCtx.drawImage(bare, 0, sy, w, sh, 0, dy, w, syStrip);
        const light = clamp(1 - 0.3 * (yp / h) * (1 - 0.22 * (ang / (Math.PI / 2))), 0.42, 1);
        if (light < 0.999) {
          baseCtx.fillStyle = `rgba(0,0,0,${(1 - light).toFixed(3)})`;
          baseCtx.fillRect(0, dy, w, syStrip);
        }
      }
      if (y0 > 0) {
        baseCtx.fillStyle = 'rgba(255,255,255,0.06)';
        baseCtx.fillRect(0, 0, w, y0);
      }
    }
    return;
  }

  // 角翻：沿对角线折起
  const br = mode === 'book_turn_br';
  const fc = 2 * (1 - p);
  if (fc <= 0) return;
  const cornerX = br ? w : 0;
  const cornerY = h;
  const px = br ? w - fc * w : fc * w;
  const py = h - fc * h;
  baseCtx.save();
  baseCtx.beginPath();
  baseCtx.moveTo(cornerX, cornerY);
  baseCtx.lineTo(px, h);
  baseCtx.lineTo(cornerX, py);
  baseCtx.closePath();
  baseCtx.clip();
  baseCtx.translate(cornerX, cornerY);
  baseCtx.scale(c, c);
  baseCtx.translate(-cornerX, -cornerY);
  baseCtx.drawImage(bare, 0, 0);
  baseCtx.setTransform(1, 0, 0, 1, 0, 0);
  baseCtx.fillStyle = 'rgba(0,0,0,0.10)';
  baseCtx.fillRect(0, 0, w, h);
  baseCtx.restore();
  baseCtx.save();
  baseCtx.strokeStyle = 'rgba(255,255,255,0.28)';
  baseCtx.lineWidth = Math.max(2, Math.round(w / 500));
  baseCtx.beginPath();
  baseCtx.moveTo(px, h);
  baseCtx.lineTo(cornerX, py);
  baseCtx.stroke();
  baseCtx.restore();
}

/* 尺寸：短边 1080，长边上限 2520（与桌面版一致） */
export function canvasSize(rw, rh) {
  const short = 1080, MAX = 2520;
  let w, h;
  if (rw >= rh) { w = Math.round(short * rw / rh / 2) * 2; h = short; }
  else { w = short; h = Math.round(short * rh / rw / 2) * 2; }
  if (Math.max(w, h) > MAX) {
    const sc = MAX / Math.max(w, h);
    w = Math.round(w * sc / 2) * 2; h = Math.round(h * sc / 2) * 2;
  }
  return [w, h];
}
