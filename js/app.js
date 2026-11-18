/* 帧隐视频 · 网页版界面与导出 */
import * as E from './engine.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_MAX = 720;      // 预览最长边，降低手机合成开销

const state = {
  text: '测试隐藏文字',
  mode: 'horizontal',
  stripe: 15,
  occlusion: 70,
  speed: 1.0,
  fontSize: 170,
  fontWidth: 1.0,
  opacity: 100,
  color: '#FFFFFF',
  aspect: [9, 16],
  fmt: 'mp4',
  bgImage: null,          // Image 对象或 null（null = 默认绿幕）
  playing: true,

  emboss: 'none',         // none | engrave | pressed
  clarity: 50,
  seq: false,
  seqSpeed: 1.0,
  seqChars: 1,
  digit: false,
  flip: 'none',
  flipDur: 0.5,
  flipInt: 0,             // 0 = 只一次
  anti: false,
  motion: 6,
  adv: 50,
};

let canvas;
let previewTarget = null;
let scene = null;
let phase = 0, previewClock = 0, rafId = null, lastT = 0;
let exporting = false;
let fullW = 1080, fullH = 1920, previewScale = 1;
let bgUrl = null;

/* ------------------------------------------------ 基础工具 --- */
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2200);
}
function setProgress(pct, label) {
  const el = $('progress');
  el.hidden = pct === null;
  if (pct !== null) {
    $('progressBar').style.width = pct + '%';
    $('progressLabel').textContent = label || (Math.round(pct) + '%');
  }
}
function even(v) {
  return Math.max(2, Math.round(v / 2) * 2);
}
function fullSize() {
  return E.canvasSize(state.aspect[0], state.aspect[1]);
}
function textLines() {
  return (state.text || '').replace(/\n+$/, '').split('\n');
}
function occlusion() {
  const v = state.anti ? Math.max(state.occlusion, 70) : state.occlusion;
  return v / 100;
}

/* ------------------------------------------------ 画布与场景 --- */
function makeTarget(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d', { willReadFrequently: true });
  const bare = document.createElement('canvas');
  bare.width = w; bare.height = h;
  const charCv = document.createElement('canvas');
  charCv.width = w; charCv.height = h;
  return {
    cv, ctx: c,
    bare, bareCtx: bare.getContext('2d'),
    char: charCv, charCtx: charCv.getContext('2d', { willReadFrequently: true }),
  };
}

function buildSceneAt(w, h, scale) {
  const lines = textLines();
  if (!lines.some((l) => l.trim())) return { chars: [] };
  return E.renderTextScene(lines, {
    width: w, height: h,
    fontSize: state.fontSize * scale,
    color: state.color,
    widthScale: state.fontWidth,
    opacity: state.opacity / 100,
    embossMode: state.emboss,
    embossClarity: state.clarity,
    digitDeform: state.digit,
    scale,
  });
}

function setupCanvas() {
  const [fw, fh] = fullSize();
  fullW = fw; fullH = fh;
  const sc = Math.min(1, PREVIEW_MAX / Math.max(fw, fh));
  previewScale = sc;
  const pw = even(fw * sc), ph = even(fh * sc);

  if (!canvas) {
    canvas = document.createElement('canvas');
    $('canvasHolder').appendChild(canvas);
  }
  canvas.width = pw; canvas.height = ph;
  const mainCtx = canvas.getContext('2d', { willReadFrequently: true });
  const bare = document.createElement('canvas');
  bare.width = pw; bare.height = ph;
  const charCv = document.createElement('canvas');
  charCv.width = pw; charCv.height = ph;
  previewTarget = {
    cv: canvas, ctx: mainCtx,
    bare, bareCtx: bare.getContext('2d'),
    char: charCv, charCtx: charCv.getContext('2d', { willReadFrequently: true }),
  };

  layoutCanvas();
  rebuildScene();
  resetPreview();
  $('sizeLabel').textContent = fw + ' × ' + fh;
}

/* 只重算显示尺寸，不动画布内容 */
function layoutCanvas() {
  if (!canvas) return;
  const stage = $('stage');
  const pad = 16;
  const availW = stage.clientWidth - pad * 2;
  const availH = stage.clientHeight - pad * 2;
  const scale = Math.min(availW / canvas.width, availH / canvas.height);
  canvas.style.width = Math.floor(canvas.width * scale) + 'px';
  canvas.style.height = Math.floor(canvas.height * scale) + 'px';
}

function rebuildScene() {
  scene = buildSceneAt(canvas.width, canvas.height, previewScale);
}

function drawBackground(c, w, h) {
  c.fillStyle = '#00FF00';                    // 默认绿幕
  c.fillRect(0, 0, w, h);
  if (state.bgImage) {
    const iw = state.bgImage.width, ih = state.bgImage.height;
    const sc = Math.max(w / iw, h / ih);
    const nw = Math.round(iw * sc), nh = Math.round(ih * sc);
    c.drawImage(state.bgImage, (w - nw) / 2, (h - nh) / 2, nw, nh);
  }
}

function compositeText(c, w, h, s, scale, frameIndex, ph, totalFrames) {
  if (!s || !s.chars.length) return;
  const pre = E.prepareFrame(state.mode, ph, Math.max(1, Math.round(state.stripe * scale)),
    occlusion(), w, h, scale);
  const img = c.getImageData(0, 0, w, h);
  const picks = state.seq
    ? E.seqPicks(s.chars.length, frameIndex, totalFrames, state.seqSpeed, state.seqChars)
    : null;
  E.compositeChars(img, s.chars, pre, {
    picks,
    motionAmp: (state.anti ? state.motion : 0) * scale,
    frameIndex,
  });
  c.putImageData(img, 0, 0);
}

/* 渲染一帧（含翻页调度）。t 为目标画布组，scale 为目标/全尺寸比例 */
function renderInto(t, s, scale, frameIndex, ph, totalFrames, allowTransition) {
  const w = t.cv.width, h = t.cv.height;
  const sched = allowTransition
    ? E.flipSchedule(frameIndex, {
      mode: state.flip, duration: state.flipDur, interval: state.flipInt, fps: E.FPS,
    })
    : { withText: true, p: null, mode: 'none' };

  if (sched.p !== null && sched.p !== undefined) {
    drawBackground(t.bareCtx, w, h);
    drawBackground(t.charCtx, w, h);
    compositeText(t.charCtx, w, h, s, scale, frameIndex, ph, totalFrames);
    E.applyTransition(t.ctx, t.bare, t.char, w, h, sched.p, sched.mode);
    return;
  }
  drawBackground(t.ctx, w, h);
  if (sched.withText) compositeText(t.ctx, w, h, s, scale, frameIndex, ph, totalFrames);
}

function resetPreview() {
  phase = 0;
  previewClock = 0;
  lastT = 0;
  if (canvas && previewTarget) {
    const total = E.FPS * E.DURATION;
    // 开了翻页时，静止画面先停在“文字页”，避免一打开只看到绿幕
    const start = (state.flip !== 'none' && state.flipDur > 0)
      ? Math.min(total - 1, Math.round((0.5 + state.flipDur + 0.05) * E.FPS))
      : 0;
    renderInto(previewTarget, scene, previewScale, start, 0, total, true);
  }
}

function tick(t) {
  if (!exporting && state.playing) {
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (dt > 0) {
      const total = E.FPS * E.DURATION;
      const fi = Math.floor(previewClock * E.FPS) % total;
      renderInto(previewTarget, scene, previewScale, fi, phase, total, true);
      const frames = dt * E.FPS;
      phase += E.advancePhase(0, previewClock * E.FPS, state.speed, state.fmt === 'gif') * frames;
      previewClock += dt;
    }
  } else {
    lastT = t;
  }
  rafId = requestAnimationFrame(tick);
}

/* ------------------------------------------------ 参数 UI --- */
function fillRange(rg, val, fmt) {
  const p = (rg.value - rg.min) / (rg.max - rg.min) * 100;
  rg.style.setProperty('--fill', p + '%');
  val.textContent = fmt(parseFloat(rg.value));
}

function bindChips(id, getV, setV, after) {
  const box = $(id);
  box.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      setV(b.dataset.v);
      box.querySelectorAll('button').forEach((x) =>
        x.classList.toggle('on', x.dataset.v === String(getV())));
      if (after) after();
    };
    b.classList.toggle('on', b.dataset.v === String(getV()));
  });
}

function bindRange(id, valId, getV, setV, fmt, needsText) {
  const rg = $(id), val = $(valId);
  rg.value = getV();
  fillRange(rg, val, fmt);
  rg.oninput = () => {
    setV(parseFloat(rg.value));
    fillRange(rg, val, fmt);
    if (needsText) rebuildScene();
    resetPreview();
  };
}

function bindSelect(id, getV, setV) {
  const el = $(id);
  el.value = getV();
  el.onchange = () => { setV(el.value); resetPreview(); };
}

function bindUI() {
  // 百叶窗模式按钮（按引擎定义生成）
  const modeBox = $('modeChips');
  for (const [key, label] of E.MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.v = key;
    b.textContent = label;
    b.classList.toggle('on', key === state.mode);
    modeBox.appendChild(b);
  }
  bindChips('modeChips', () => state.mode, (v) => { state.mode = v; }, resetPreview);

  $('inpText').value = state.text;
  $('inpText').addEventListener('input', () => {
    state.text = $('inpText').value;
    rebuildScene();
    resetPreview();
  });

  bindChips('aspectChips', () => state.aspect.join(':'), (v) => {
    const [a, b] = v.split(':').map(Number);
    state.aspect = [a, b];
    setupCanvas();
  });
  bindChips('fmtChips', () => state.fmt, (v) => { state.fmt = v; }, resetPreview);

  bindRange('rgFont', 'valFont', () => state.fontSize, (v) => { state.fontSize = v; },
    (v) => v + ' px', true);
  bindRange('rgFontWidth', 'valFontWidth', () => state.fontWidth, (v) => { state.fontWidth = v; },
    (v) => v.toFixed(2) + '×', true);
  bindRange('rgOpacity', 'valOpacity', () => state.opacity, (v) => { state.opacity = v; },
    (v) => v + '%', true);
  bindRange('rgStripe', 'valStripe', () => state.stripe, (v) => { state.stripe = v; },
    (v) => v + ' px', false);
  bindRange('rgOcclusion', 'valOcclusion', () => state.occlusion, (v) => { state.occlusion = v; },
    (v) => v + '%', false);
  bindRange('rgSpeed', 'valSpeed', () => state.speed, (v) => { state.speed = v; },
    (v) => v.toFixed(1) + 'x', false);

  bindRange('rgClarity', 'valClarity', () => state.clarity, (v) => { state.clarity = v; },
    (v) => v + '%', true);
  bindRange('rgSeqSpeed', 'valSeqSpeed', () => state.seqSpeed, (v) => { state.seqSpeed = v; },
    (v) => v.toFixed(1) + 'x', false);
  bindRange('rgSeqChars', 'valSeqChars', () => state.seqChars, (v) => { state.seqChars = v; },
    (v) => String(v), false);
  bindRange('rgMotion', 'valMotion', () => state.motion, (v) => { state.motion = v; },
    (v) => v + ' px', false);
  bindRange('rgAdv', 'valAdv', () => state.adv, (v) => { state.adv = v; },
    (v) => v + '%', false);

  bindChips('embossChips', () => state.emboss, (v) => { state.emboss = v; },
    () => { rebuildScene(); resetPreview(); });

  $('inpColor').value = state.color;
  $('inpColor').addEventListener('input', () => {
    state.color = $('inpColor').value;
    rebuildScene();
    resetPreview();
  });

  $('swSeq').checked = state.seq;
  $('seqRows').hidden = !state.seq;
  $('swSeq').onchange = () => {
    state.seq = $('swSeq').checked;
    $('seqRows').hidden = !state.seq;
    resetPreview();
  };

  $('swDigit').checked = state.digit;
  $('swDigit').onchange = () => {
    state.digit = $('swDigit').checked;
    rebuildScene();
    resetPreview();
  };

  $('swAnti').checked = state.anti;
  $('antiRows').hidden = !state.anti;
  $('swAnti').onchange = () => {
    state.anti = $('swAnti').checked;
    $('antiRows').hidden = !state.anti;
    if (state.anti && state.occlusion < 70) {
      state.occlusion = 70;
      $('rgOcclusion').value = 70;
      fillRange($('rgOcclusion'), $('valOcclusion'), (v) => v + '%');
    }
    resetPreview();
  };

  bindSelect('selFlip', () => state.flip, (v) => { state.flip = v; });
  bindSelect('selFlipDur', () => String(state.flipDur), (v) => { state.flipDur = parseFloat(v); });
  bindSelect('selFlipInt', () => String(state.flipInt), (v) => { state.flipInt = parseFloat(v); });

  $('btnPause').onclick = () => {
    state.playing = !state.playing;
    $('btnPause').textContent = state.playing ? '暂停' : '播放';
  };

  $('btnBg').onclick = () => $('fileBg').click();
  $('fileBg').addEventListener('change', () => {
    const f = $('fileBg').files[0];
    if (!f) return;
    const img = new Image();
    const url = URL.createObjectURL(f);
    img.onload = () => {
      if (bgUrl) URL.revokeObjectURL(bgUrl);
      bgUrl = url;
      state.bgImage = img;
      $('btnBgClear').hidden = false;
      toast('背景已设置');
      resetPreview();
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    $('fileBg').value = '';
  });
  $('btnBgClear').onclick = () => {
    state.bgImage = null;
    $('btnBgClear').hidden = true;
    toast('已恢复默认绿幕');
    resetPreview();
  };

  $('btnExport').onclick = doExport;

  window.addEventListener('resize', layoutCanvas);
}

/* ------------------------------------------------ 防AI扰动 --- */
let advTile = null;
function getAdvTile() {
  if (advTile) return advTile;
  const small = document.createElement('canvas');
  small.width = 16; small.height = 16;
  const sctx = small.getContext('2d');
  const id = sctx.createImageData(16, 16);
  for (let i = 0; i < 16 * 16; i++) {
    const v = 100 + Math.random() * 55;
    id.data[i * 4] = v;
    id.data[i * 4 + 1] = v;
    id.data[i * 4 + 2] = v;
    id.data[i * 4 + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);
  const tile = document.createElement('canvas');
  tile.width = 128; tile.height = 128;
  const tctx = tile.getContext('2d');
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(small, 0, 0, 128, 128);
  advTile = tile;
  return tile;
}

function applyAdv(c, w, h, frameIndex) {
  if (!state.anti || state.adv <= 0) return;
  const tile = getAdvTile();
  const pat = c.createPattern(tile, 'repeat');
  const dx = (frameIndex * 2) % 128, dy = (frameIndex * 3) % 128;
  c.save();
  c.globalCompositeOperation = 'overlay';
  c.globalAlpha = 0.06 + 0.12 * (state.adv / 100);
  c.fillStyle = pat;
  c.translate(dx, dy);
  c.fillRect(-dx, -dy, w, h);
  c.restore();
}

/* ------------------------------------------------ 导出 --- */
function outName(fmt) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '帧隐视频_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + fmt;
}

async function exportMp4() {
  const { Mp4Muxer } = window;
  const w = fullW, h = fullH;
  const fps = E.FPS;
  const total = E.FPS * E.DURATION;
  const codec = 'avc1.420028';                 // Baseline Level 4.0
  const support = await VideoEncoder.isConfigSupported({
    codec, width: w, height: h, bitrate: 9_000_000, framerate: fps,
  });
  if (!support.supported) throw new Error('此浏览器不支持视频导出');

  const muxer = new Mp4Muxer.Muxer({
    target: new Mp4Muxer.ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    fastStart: 'in-memory',
  });
  let encError = null;
  let gotConfig = false;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!gotConfig) {
        gotConfig = !!(meta && meta.decoderConfig && meta.decoderConfig.description);
        if (!gotConfig) {
          encError = new Error('此浏览器不支持视频导出，请改用 GIF');
          try { encoder.close(); } catch (e) {}
        }
      }
      muxer.addVideoChunk(chunk, meta);
    },
    error: (e) => { encError = e; },
  });
  encoder.configure({
    codec, width: w, height: h, bitrate: 9_000_000,
    framerate: fps, latencyMode: 'quality',
    avc: { format: 'avc' },
  });

  const s = buildSceneAt(w, h, 1);
  const target = makeTarget(w, h);
  const usPerFrame = 1e6 / fps;
  for (let fc = 0; fc < total; fc++) {
    if (encError) throw encError;
    renderInto(target, s, 1, fc, phase, total, true);
    applyAdv(target.ctx, w, h, fc);
    const frame = new VideoFrame(target.cv, {
      timestamp: Math.round(fc * usPerFrame),
      duration: Math.round(usPerFrame),
    });
    encoder.encode(frame, { keyFrame: fc % 60 === 0 });
    frame.close();
    while (encoder.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 8));
    }
    if (fc % 5 === 0) {
      setProgress(fc / total * 92);
      await new Promise((r) => setTimeout(r, 0));
    }
    phase = E.advancePhase(phase, fc, state.speed, false);
  }
  setProgress(95, '正在完成…');
  await encoder.flush();
  encoder.close();
  muxer.finalize();
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}

async function exportGif() {
  const { GIFEncoder, quantize, applyPalette } = await import('../vendor/gifenc.js');
  const [fw, fh] = fullSize();
  const maxEdge = 480;
  const sc = Math.min(1, maxEdge / Math.max(fw, fh));
  const gw = even(fw * sc), gh = even(fh * sc);
  const gsc = gw / fw;
  const total = E.FPS * E.GIF_DURATION;                 // 90 帧
  const s = buildSceneAt(gw, gh, gsc);
  const target = makeTarget(gw, gh);

  const gif = GIFEncoder();
  let written = 0;
  for (let fc = 0; fc < total; fc++) {
    renderInto(target, s, gsc, fc, phase, total, true);
    if (written % E.GIF_STRIDE === 0) {
      const { data } = target.ctx.getImageData(0, 0, gw, gh);
      const palette = quantize(data, 64);
      const idx = applyPalette(data, palette);
      gif.writeFrame(idx, gw, gh, { palette, delay: Math.round(1000 / E.GIF_FPS) });
      setProgress(fc / total * 92);
      await new Promise((r) => setTimeout(r, 0));
    }
    written++;
    phase = E.advancePhase(phase, fc, state.speed, true);
  }
  gif.finish();
  return new Blob([gif.bytesView()], { type: 'image/gif' });
}

async function saveBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  // 手机上优先调系统分享（可直接存相册/发给别人）
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;   // 用户取消分享
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function doExport() {
  if (exporting) return;
  if (!(state.text || '').replace(/\n+$/, '').trim()) {
    toast('请先输入要隐藏的文字'); return;
  }
  if (state.fmt === 'mp4' && typeof VideoEncoder === 'undefined') {
    toast('此浏览器不支持视频导出，请改用 GIF 或更换浏览器');
    return;
  }
  exporting = true;
  const wasPlaying = state.playing;
  state.playing = false;
  window.__lastExportError = null;
  $('btnExport').disabled = true;
  $('btnExport').textContent = '生成中…';
  phase = 0;
  const wasGif = state.fmt === 'gif';
  const name = outName(wasGif ? 'gif' : 'mp4');
  try {
    const blob = wasGif ? await exportGif() : await exportMp4();
    setProgress(100, '完成');
    await saveBlob(blob, name);
    toast(wasGif ? 'GIF 已生成' : '视频已生成');
    setTimeout(() => setProgress(null), 1500);
  } catch (ex) {
    console.error(ex);
    window.__lastExportError = (ex && ex.stack) ? String(ex.stack) : String(ex);
    setProgress(null);
    toast('生成失败，请重试');
  } finally {
    exporting = false;
    $('btnExport').disabled = false;
    $('btnExport').textContent = '生成并保存';
    state.playing = wasPlaying;         // 尊重导出前的暂停状态
    $('btnPause').textContent = wasPlaying ? '暂停' : '播放';
    resetPreview();
  }
}

/* ------------------------------------------------ 启动 --- */
function init() {
  setupCanvas();
  bindUI();
  resetPreview();
  tick();

  // 更新预览尺寸标签
  $('sizeLabel').textContent = fullW + ' × ' + fullH;

  // Service Worker（仅 HTTPS 或本机可用，局域网 IP 下自动跳过）
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => { reg.update().catch(() => {}); })
      .catch(() => {});
  }
}
init();
