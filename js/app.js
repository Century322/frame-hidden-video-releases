/* 帧隐视频 · 网页版界面与导出 */
import * as E from './engine.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_MAX = 720;      // 预览最长边，降低手机合成开销
const PREFS_KEY = 'framehidden.prefs.v2';

const ASPECTS = {
  '9:16': [9, 16],
  '16:9': [16, 9],
  '1:1': [1, 1],
  '4:5': [4, 5],
  '3:4': [3, 4],
  '21:9': [21, 9],
};

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
  bgImage: null,          // Image 对象或 null
  bgVideo: null,          // HTMLVideoElement 或 null
  bgVideoFile: null,      // 原视频 File，导出原声用
  bgKind: 'none',         // none | image | video
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
  flipBeforeAnti: 'none',
  anti: false,
  motion: 6,
  adv: 50,
  gifEdge: 480,
  duration: 5,
  customW: 4,
  customH: 5,
  customAspect: false,
  perspX: 0,
  perspY: 0,
  offsetX: 0,
  offsetY: 0,
};

let canvas;
let previewTarget = null;
let scene = null;
let phase = 0, previewClock = 0, rafId = null, lastT = 0;
let exporting = false;
let fullW = 1080, fullH = 1920, previewScale = 1;
let bgUrl = null;
let bgToken = 0;
let progressHideTimer = null;

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
function previewTotal() {
  let sec = state.fmt === 'gif' ? E.GIF_DURATION : state.duration;
  if (state.fmt !== 'gif' && state.bgKind === 'video' && state.bgVideo
      && isFinite(state.bgVideo.duration) && state.bgVideo.duration > 0) {
    sec = Math.min(sec, state.bgVideo.duration);
  }
  return Math.max(1, Math.round(E.FPS * sec));
}
function occlusion() {
  const v = state.anti ? Math.max(state.occlusion, 70) : state.occlusion;
  return v / 100;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
function aspectKey() {
  if (state.customAspect) return 'custom';
  const k = state.aspect.join(':');
  return ASPECTS[k] ? k : 'custom';
}

/* ------------------------------------------------ 参数记忆 --- */
const PREF_KEYS = [
  'text', 'mode', 'stripe', 'occlusion', 'speed', 'fontSize', 'fontWidth',
  'opacity', 'color', 'aspect', 'fmt', 'emboss', 'clarity', 'seq', 'seqSpeed',
  'seqChars', 'digit', 'flip', 'flipDur', 'flipInt', 'anti', 'motion', 'adv',
  'gifEdge', 'duration', 'customW', 'customH', 'customAspect',
  'perspX', 'perspY', 'offsetX', 'offsetY',
];

function loadPrefs() {
  let p;
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  } catch (e) {
    return;
  }
  if (!p || typeof p !== 'object') return;
  const num = (v, lo, hi, def) => (typeof v === 'number' && isFinite(v))
    ? clamp(v, lo, hi) : def;
  if (typeof p.text === 'string') state.text = p.text.slice(0, 2000);
  if (E.MODES.some(([k]) => k === p.mode)) state.mode = p.mode;
  state.stripe = num(p.stripe, 4, 60, state.stripe);
  state.occlusion = num(p.occlusion, 0, 100, state.occlusion);
  state.speed = num(p.speed, 0.3, 3, state.speed);
  state.fontSize = num(p.fontSize, 40, 300, state.fontSize);
  state.fontWidth = num(p.fontWidth, 0.5, 2, state.fontWidth);
  state.opacity = num(p.opacity, 0, 100, state.opacity);
  if (typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) state.color = p.color;
  if (Array.isArray(p.aspect) && p.aspect.length === 2
      && p.aspect.every((v) => typeof v === 'number' && isFinite(v) && v > 0 && v <= 200)) {
    state.aspect = [p.aspect[0], p.aspect[1]];
  }
  state.customW = Math.round(num(p.customW, 1, 200, state.customW));
  state.customH = Math.round(num(p.customH, 1, 200, state.customH));
  state.customAspect = !!p.customAspect;
  if (!ASPECTS[state.aspect.join(':')]) {
    state.customAspect = true;
    state.customW = Math.round(state.aspect[0]);
    state.customH = Math.round(state.aspect[1]);
  }
  if (p.fmt === 'mp4' || p.fmt === 'gif') state.fmt = p.fmt;
  if (['none', 'engrave', 'pressed'].includes(p.emboss)) state.emboss = p.emboss;
  state.clarity = num(p.clarity, 0, 100, state.clarity);
  state.seq = !!p.seq;
  state.seqSpeed = num(p.seqSpeed, 0.2, 15, state.seqSpeed);
  state.seqChars = Math.round(num(p.seqChars, 1, 10, state.seqChars));
  state.digit = !!p.digit;
  if (E.FLIP_MODES.some(([k]) => k === p.flip)) state.flip = p.flip;
  state.flipDur = num(p.flipDur, 0.3, 1.2, state.flipDur);
  state.flipInt = [0, 3, 5, 8].includes(p.flipInt) ? p.flipInt : state.flipInt;
  state.anti = !!p.anti;
  state.motion = num(p.motion, 0, 20, state.motion);
  state.adv = num(p.adv, 0, 100, state.adv);
  state.gifEdge = [480, 500, 360].includes(p.gifEdge) ? p.gifEdge : state.gifEdge;
  state.duration = [5, 8, 10, 15].includes(p.duration) ? p.duration : state.duration;
  state.perspX = num(p.perspX, -100, 100, 0);
  state.perspY = num(p.perspY, -100, 100, 0);
  state.offsetX = num(p.offsetX, -0.45, 0.45, 0);
  state.offsetY = num(p.offsetY, -0.45, 0.45, 0);
}

function savePrefs() {
  const p = {};
  for (const k of PREF_KEYS) p[k] = state[k];
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch (e) {}
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePrefs, 350);
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
  const video = state.bgKind === 'video' ? state.bgVideo : null;
  const src = video && video.readyState >= 2 ? video : state.bgImage;
  if (!src) return;
  const iw = video ? video.videoWidth : (src.naturalWidth || src.width);
  const ih = video ? video.videoHeight : (src.naturalHeight || src.height);
  if (!iw || !ih) return;
  const sc = Math.max(w / iw, h / ih);
  const nw = Math.round(iw * sc), nh = Math.round(ih * sc);
  c.drawImage(src, (w - nw) / 2, (h - nh) / 2, nw, nh);
}

function syncBgVideo() {
  const v = state.bgVideo;
  if (!v) return;
  if (state.playing && !exporting) v.play().catch(() => {});
  else v.pause();
}

function clearBackground() {
  bgToken++;
  if (state.bgVideo) {
    try { state.bgVideo.pause(); } catch (e) {}
    state.bgVideo.removeAttribute('src');
    try { state.bgVideo.load(); } catch (e) {}
    state.bgVideo.remove();
  }
  state.bgVideo = null;
  state.bgVideoFile = null;
  state.bgImage = null;
  state.bgKind = 'none';
  if (bgUrl) {
    URL.revokeObjectURL(bgUrl);
    bgUrl = null;
  }
}

let warpCanvas = null, warpCtx = null;
function getWarpCtx(w, h) {
  if (!warpCanvas) {
    warpCanvas = document.createElement('canvas');
    warpCtx = warpCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (warpCanvas.width !== w || warpCanvas.height !== h) {
    warpCanvas.width = w;
    warpCanvas.height = h;
  }
  return warpCtx;
}

function compositeText(c, w, h, s, scale, frameIndex, ph, totalFrames) {
  if (!s || !s.chars.length) return;
  const pre = E.prepareFrame(state.mode, ph, Math.max(1, Math.round(state.stripe * scale)),
    occlusion(), w, h, scale);
  const img = c.getImageData(0, 0, w, h);
  const picks = state.seq
    ? E.seqPicks(s.chars.length, frameIndex, totalFrames, state.seqSpeed, state.seqChars)
    : null;
  const opts = {
    picks,
    motionAmp: (state.anti ? state.motion : 0) * scale,
    frameIndex,
    offsetX: state.offsetX * w,
    offsetY: state.offsetY * h,
  };
  const px = state.perspX / 100 * 0.35;
  const py = state.perspY / 100 * 0.35;
  if (Math.abs(px) > 0.0005 || Math.abs(py) > 0.0005) {
    E.compositeCharsWarp(img, s.chars, pre,
      { ...opts, perspX: px, perspY: py }, getWarpCtx(w, h));
  } else {
    E.compositeChars(img, s.chars, pre, opts);
  }
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
    const total = previewTotal();
    // 开了翻页时，静止画面先停在“文字页”，避免一打开只看到绿幕
    const start = (state.flip !== 'none' && state.flipDur > 0)
      ? Math.min(total - 1, Math.round((0.5 + state.flipDur + 0.05) * E.FPS))
      : 0;
    renderInto(previewTarget, scene, previewScale, start, 0, total, true);
    scheduleSave();
  }
}

function renderCurrentPreview() {
  if (!canvas || !previewTarget) return;
  const total = previewTotal();
  const fi = Math.floor(previewClock * E.FPS) % total;
  renderInto(previewTarget, scene, previewScale, fi, phase, total, true);
}

function setOffset(x, y) {
  state.offsetX = clamp(x, -0.45, 0.45);
  state.offsetY = clamp(y, -0.45, 0.45);
  $('btnPosReset').hidden = Math.abs(state.offsetX) < 0.002 && Math.abs(state.offsetY) < 0.002;
  renderCurrentPreview();
}

function updatePosUi() {
  $('btnPosReset').hidden = Math.abs(state.offsetX) < 0.002 && Math.abs(state.offsetY) < 0.002;
}

function tick(t) {
  if (!exporting && state.playing) {
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
    lastT = t;
    if (dt > 0) {
      const total = previewTotal();
      const maxVideoT = total / E.FPS;
      const v = state.bgVideo;
      if (state.bgKind === 'video' && v && state.playing
          && v.currentTime >= maxVideoT - 0.02) {
        try { v.currentTime = 0; } catch (e) {}
      }
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

function bindSelect(id, getV, setV, after) {
  const el = $(id);
  el.value = getV();
  el.onchange = () => {
    setV(el.value);
    if (after) after();
    resetPreview();
  };
}

let activeTab = 'font';
let drawerOpen = false;
const TAB_LABELS = { font: '字体', visual: '画面', effect: '效果' };

function isMobile() {
  return window.matchMedia('(max-width: 759px)').matches;
}

function setActiveTab(name) {
  closeDropdown();
  if (document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
  activeTab = name;
  document.querySelectorAll('.tab-page').forEach((sec) => {
    sec.classList.toggle('active', sec.dataset.tab === name);
  });
  document.querySelectorAll('#tabbar button, #pcTabs button').forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  const title = $('drawerTitle');
  if (title) title.textContent = TAB_LABELS[name] || '';
  if (!isMobile()) {
    const controls = $('controls');
    if (controls) controls.scrollTop = 0;
  }
}

function openDrawer() {
  if (!isMobile()) return;
  drawerOpen = true;
  closeDropdown();
  const controls = $('controls');
  const backdrop = $('drawerBackdrop');
  if (controls) {
    controls.classList.add('open');
    controls.scrollTop = 0;
  }
  if (backdrop) backdrop.hidden = false;
}

function closeDrawer() {
  drawerOpen = false;
  closeDropdown();
  const controls = $('controls');
  const backdrop = $('drawerBackdrop');
  if (controls) controls.classList.remove('open');
  if (backdrop) backdrop.hidden = true;
}

function handleTabClick(name) {
  if (isMobile()) {
    if (drawerOpen && activeTab === name) {
      closeDrawer();
      return;
    }
    setActiveTab(name);
    openDrawer();
  } else {
    setActiveTab(name);
  }
}

/* ------------------------------------------------ 自绘下拉 --- */
const ddEntries = [];
let ddOpen = null;

function enhanceSelect(sel) {
  if (!sel || sel.dataset.ddEnhanced) return;
  sel.dataset.ddEnhanced = '1';
  const dd = document.createElement('div');
  dd.className = 'dd';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const label = sel.getAttribute('aria-label');
  if (label) btn.setAttribute('aria-label', label);
  const text = document.createElement('span');
  text.className = 'dd-text';
  const arrow = document.createElement('span');
  arrow.className = 'dd-arrow';
  arrow.textContent = '▾';
  btn.append(text, arrow);
  dd.append(btn);
  sel.parentNode.insertBefore(dd, sel);
  sel.hidden = true;
  const sync = () => {
    const opt = sel.options[sel.selectedIndex];
    text.textContent = opt ? opt.textContent : '';
    btn.disabled = sel.disabled;
  };
  sync();
  sel.addEventListener('change', sync);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown(sel, btn);
  });
  ddEntries.push({ sel, btn, text, sync, dd });
}

function enhanceAllSelects() {
  document.querySelectorAll('select.native-select').forEach(enhanceSelect);
  syncCustomSelects();
}

function syncCustomSelects() {
  ddEntries.forEach((e) => e.sync());
}

function closeDropdown() {
  if (!ddOpen) return;
  ddOpen.btn.setAttribute('aria-expanded', 'false');
  const menu = $('ddMenu');
  if (menu) {
    menu.hidden = true;
    menu.innerHTML = '';
  }
  ddOpen = null;
}

function toggleDropdown(sel, btn) {
  if (ddOpen && ddOpen.sel === sel) {
    closeDropdown();
    return;
  }
  if (sel.disabled) return;
  closeDropdown();
  const menu = $('ddMenu');
  if (!menu) return;
  ddOpen = { sel, btn };
  btn.setAttribute('aria-expanded', 'true');
  menu.innerHTML = '';
  menu.setAttribute('role', 'listbox');
  [...sel.options].forEach((opt) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'dd-item';
    item.textContent = opt.textContent;
    item.setAttribute('role', 'option');
    const on = opt.value === sel.value;
    if (on) {
      item.classList.add('on');
      item.setAttribute('aria-selected', 'true');
    }
    item.onclick = (e) => {
      e.stopPropagation();
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      closeDropdown();
    };
    menu.appendChild(item);
  });
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const mw = Math.max(Math.round(r.width), 140);
  menu.style.width = mw + 'px';
  const mh = menu.offsetHeight;
  let left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - mw - 8));
  let top = r.bottom + 6;
  const forceUp = !!btn.closest('#exportBar');
  if ((forceUp || top + mh > window.innerHeight - 8) && r.top - mh - 6 > 8) {
    top = r.top - mh - 6;
  }
  top = Math.max(8, Math.min(top, window.innerHeight - mh - 8));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function syncFmtFields() {
  $('gifSizeField').hidden = state.fmt !== 'gif';
  $('durationField').hidden = state.fmt !== 'mp4';
}

function syncAspectFields() {
  const custom = state.customAspect;
  $('customAspectRow').hidden = !custom;
  if (custom) {
    $('inpCustomW').value = state.customW;
    $('inpCustomH').value = state.customH;
  }
}

function applyAntiUi() {
  $('swAnti').checked = state.anti;
  $('antiRows').hidden = !state.anti;
  if (state.anti) {
    // 翻页会露出完整字，与“任意单帧不出现完整字”冲突，直接禁用
    if (state.flip !== 'none') {
      state.flipBeforeAnti = state.flip;
      state.flip = 'none';
    }
    $('selFlip').value = 'none';
    $('selFlip').disabled = true;
    $('selFlipDur').disabled = true;
    $('selFlipInt').disabled = true;
    $('flipAntiNote').hidden = false;
    $('rgOcclusion').disabled = true;
    if (state.occlusion < 70) {
      state.occlusion = 70;
      $('rgOcclusion').value = 70;
      fillRange($('rgOcclusion'), $('valOcclusion'), (v) => v + '%');
    }
  } else {
    $('selFlip').disabled = false;
    $('selFlipDur').disabled = false;
    $('selFlipInt').disabled = false;
    $('flipAntiNote').hidden = true;
    $('rgOcclusion').disabled = false;
    if (state.flipBeforeAnti && state.flipBeforeAnti !== 'none') {
      state.flip = state.flipBeforeAnti;
      $('selFlip').value = state.flip;
    }
    state.flipBeforeAnti = 'none';
  }
  syncCustomSelects();
}

function bindUI() {
  // 百叶窗模式按钮（按引擎定义生成）
  const modeBox = $('modeChips');  for (const [key, label] of E.MODES) {
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

  bindChips('aspectChips', aspectKey, (v) => {
    if (v === 'custom') {
      state.customAspect = true;
      state.aspect = [state.customW, state.customH];
    } else {
      state.customAspect = false;
      state.aspect = ASPECTS[v].slice();
    }
    syncAspectFields();
    setupCanvas();
  });
  const applyCustomAspect = () => {
    const w = clamp(parseInt($('inpCustomW').value, 10) || 1, 1, 200);
    const h = clamp(parseInt($('inpCustomH').value, 10) || 1, 1, 200);
    state.customAspect = true;
    state.customW = w;
    state.customH = h;
    state.aspect = [w, h];
    syncAspectFields();
    setupCanvas();
  };
  $('inpCustomW').addEventListener('change', applyCustomAspect);
  $('inpCustomH').addEventListener('change', applyCustomAspect);
  bindSelect('selFmt', () => state.fmt, (v) => { state.fmt = v; }, syncFmtFields);

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
  bindRange('rgPerspX', 'valPerspX', () => state.perspX, (v) => { state.perspX = v; },
    (v) => (v > 0 ? '+' + v : String(v)), false);
  bindRange('rgPerspY', 'valPerspY', () => state.perspY, (v) => { state.perspY = v; },
    (v) => (v > 0 ? '+' + v : String(v)), false);
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

  $('swAnti').onchange = () => {
    state.anti = $('swAnti').checked;
    applyAntiUi();
    resetPreview();
  };

  bindSelect('selFlip', () => state.flip, (v) => { if (!state.anti) state.flip = v; });
  bindSelect('selFlipDur', () => String(state.flipDur), (v) => { state.flipDur = parseFloat(v); });
  bindSelect('selFlipInt', () => String(state.flipInt), (v) => { state.flipInt = parseFloat(v); });
  bindSelect('selGifEdge', () => String(state.gifEdge), (v) => { state.gifEdge = parseInt(v, 10) || 480; });
  bindSelect('selDuration', () => String(state.duration), (v) => { state.duration = parseFloat(v) || 5; });
  syncFmtFields();
  syncAspectFields();

  $('btnPause').onclick = () => {
    state.playing = !state.playing;
    $('btnPause').textContent = state.playing ? '暂停' : '播放';
    syncBgVideo();
  };

  // 拖动画布调整文字位置（双击或按钮复位）
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    $('posHint').hidden = true;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: state.offsetX, oy: state.offsetY };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    setOffset(drag.ox + (e.clientX - drag.x) / r.width,
      drag.oy + (e.clientY - drag.y) / r.height);
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    savePrefs();
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => { setOffset(0, 0); savePrefs(); });
  $('btnPosReset').onclick = () => { setOffset(0, 0); savePrefs(); };
  updatePosUi();
  setTimeout(() => { $('posHint').hidden = true; }, 5000);

  $('btnBg').onclick = () => $('fileBg').click();
  $('fileBg').addEventListener('change', () => {
    const f = $('fileBg').files[0];
    $('fileBg').value = '';
    if (!f) return;
    if (f.size > 100 * 1024 * 1024) {
      toast('文件过大，请选择 100MB 以内的背景');
      return;
    }
    clearBackground();
    const token = ++bgToken;
    const url = URL.createObjectURL(f);
    bgUrl = url;
    const isVideo = (f.type || '').startsWith('video/')
      || /\.(mp4|mov|webm|m4v|avi|mkv)$/i.test(f.name || '');
    if (isVideo) {
      const v = document.createElement('video');
      v.src = url;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      $('bgVideoHolder').replaceChildren(v);
      v.onloadedmetadata = () => {
        if (token !== bgToken) return;
        state.bgVideo = v;
        state.bgVideoFile = f;
        state.bgKind = 'video';
        $('btnBgClear').hidden = false;
        toast('视频背景已设置，导出会保留原声');
        syncBgVideo();
        resetPreview();
      };
      v.onloadeddata = () => {
        if (token !== bgToken) return;
        syncBgVideo();
        resetPreview();
      };
      v.onerror = () => {
        if (token !== bgToken) return;
        toast('无法读取这个视频，请换一个文件');
        clearBackground();
        $('btnBgClear').hidden = true;
        resetPreview();
      };
      v.load();
    } else {
      const img = new Image();
      img.onload = () => {
        if (token !== bgToken) return;
        state.bgImage = img;
        state.bgKind = 'image';
        $('btnBgClear').hidden = false;
        toast('背景图片已设置');
        resetPreview();
      };
      img.onerror = () => {
        if (token !== bgToken) return;
        toast('无法读取这张图片');
        clearBackground();
        $('btnBgClear').hidden = true;
        resetPreview();
      };
      img.src = url;
    }
  });
  $('btnBgClear').onclick = () => {
    clearBackground();
    $('btnBgClear').hidden = true;
    toast('已恢复默认绿幕');
    resetPreview();
  };

  $('btnExport').onclick = doExport;

  document.querySelectorAll('#tabbar button, #pcTabs button').forEach((btn) => {
    btn.onclick = () => handleTabClick(btn.dataset.tab);
  });
  $('drawerClose').onclick = closeDrawer;
  $('drawerBackdrop').onclick = closeDrawer;

  document.addEventListener('pointerdown', (e) => {
    if (!ddOpen) return;
    const menu = $('ddMenu');
    if (menu && (menu.contains(e.target) || ddOpen.btn.contains(e.target))) return;
    closeDropdown();
  }, true);
  window.addEventListener('scroll', () => {
    if (ddOpen) closeDropdown();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDropdown();
      closeDrawer();
    }
  });
  let lastMobile = isMobile();
  window.addEventListener('resize', () => {
    layoutCanvas();
    closeDropdown();
    const nowMobile = isMobile();
    if (nowMobile !== lastMobile) {
      closeDrawer();
      lastMobile = nowMobile;
    }
  });
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

/* ------------------------------------------------ 视频背景 --- */
let muxerPromise = null;
function ensureMp4Muxer() {
  if (window.Mp4Muxer) return Promise.resolve(window.Mp4Muxer);
  if (!muxerPromise) {
    muxerPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = './vendor/mp4-muxer.js';
      s.onload = () => {
        if (window.Mp4Muxer) resolve(window.Mp4Muxer);
        else reject(new Error('此浏览器无法加载视频导出组件，请检查网络后重试'));
      };
      s.onerror = () => reject(new Error('此浏览器无法加载视频导出组件，请检查网络后重试'));
      document.head.appendChild(s);
    }).catch((e) => { muxerPromise = null; throw e; });
  }
  return muxerPromise;
}

/* 把视频精确定位到某一时刻，供逐帧导出使用 */
async function seekVideoTo(video, t) {
  if (!video) return;
  if (video.readyState < 2) {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; video.removeEventListener('loadeddata', finish); resolve(); };
      video.addEventListener('loadeddata', finish);
      setTimeout(finish, 1500);
    });
  }
  const dur = isFinite(video.duration) ? video.duration : 0;
  const target = dur > 0 ? Math.min(Math.max(0, t), Math.max(0, dur - 0.001)) : Math.max(0, t);
  if (Math.abs(video.currentTime - target) < 0.002) return;
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      video.removeEventListener('seeked', finish);
      resolve();
    };
    video.addEventListener('seeked', finish);
    try { video.currentTime = target; } catch (e) { finish(); }
    setTimeout(finish, 1500);
  });
  // 让解码后的这一帧有机会进入绘制管线
  await new Promise((r) => setTimeout(r, 0));
}

/* 从原视频里解出音轨，再编码成 AAC；失败返回 null（导出无声视频） */
async function encodeAudioFromVideo(file, duration) {
  if (!file || typeof AudioEncoder === 'undefined') return null;
  let actx = null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    actx = new Ctx();
    if (actx.state === 'suspended') {
      try { await actx.resume(); } catch (e) {}
    }
    const raw = await file.arrayBuffer();
    const ab = await actx.decodeAudioData(raw.slice(0));
    const numberOfChannels = Math.min(2, ab.numberOfChannels || 1);
    const sampleRate = ab.sampleRate;
    const totalSamples = Math.min(ab.length, Math.max(0, Math.floor(sampleRate * duration)));
    if (totalSamples < 1024) return null;
    const support = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 128000,
    });
    if (!support.supported) return null;
    const chunks = [];
    let encError = null;
    const enc = new AudioEncoder({
      output: (chunk, meta) => chunks.push([chunk, meta]),
      error: (e) => { encError = e; },
    });
    enc.configure({
      codec: 'mp4a.40.2', sampleRate, numberOfChannels, bitrate: 128000,
    });
    const BLOCK = 1024;
    for (let off = 0; off < totalSamples; off += BLOCK) {
      const n = Math.min(BLOCK, totalSamples - off);
      const data = new Float32Array(n * numberOfChannels);
      for (let c = 0; c < numberOfChannels; c++) {
        const src = ab.getChannelData(Math.min(c, ab.numberOfChannels - 1));
        data.set(src.subarray(off, off + n), c * n);
      }
      const ad = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels,
        timestamp: Math.round(off / sampleRate * 1e6),
        data,
      });
      enc.encode(ad);
      ad.close();
    }
    await enc.flush();
    enc.close();
    if (encError) throw encError;
    if (!chunks.length) return null;
    const hasDesc = chunks.some(([, m]) => m && m.decoderConfig && m.decoderConfig.description);
    if (!hasDesc) return null;
    return { chunks, config: { codec: 'aac', numberOfChannels, sampleRate } };
  } catch (e) {
    return null;
  } finally {
    try { if (actx) await actx.close(); } catch (e) {}
  }
}

/* ------------------------------------------------ 导出 --- */
function outName(fmt) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return '帧隐视频_' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + '.' + fmt;
}

async function exportMp4() {
  const { Muxer, ArrayBufferTarget } = await ensureMp4Muxer();
  const w = fullW, h = fullH;
  const fps = E.FPS;
  const isVideoBg = state.bgKind === 'video' && !!state.bgVideo;
  let duration = state.duration;
  if (isVideoBg && isFinite(state.bgVideo.duration) && state.bgVideo.duration > 0) {
    duration = Math.min(duration, state.bgVideo.duration);
  }
  const total = Math.max(1, Math.round(fps * duration));
  if (isVideoBg) {
    try { state.bgVideo.pause(); } catch (e) {}
  }

  // 视频背景：先解出原声并编码 AAC；失败就导出无声视频
  let audio = null;
  if (isVideoBg && state.bgVideoFile) {
    setProgress(1, '正在准备原声…');
    await new Promise((r) => setTimeout(r, 0));
    audio = await encodeAudioFromVideo(state.bgVideoFile, duration);
  }

  const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
  // 1080p 级别用 Level 4.0；21:9 等更宽的画布用 Level 5.0
  let codec = mb <= 8192 ? 'avc1.420028' : 'avc1.420032';
  let support = await VideoEncoder.isConfigSupported({
    codec, width: w, height: h, bitrate: 9_000_000, framerate: fps,
  });
  if (!support.supported) {
    codec = mb <= 8192 ? 'avc1.420032' : 'avc1.420033';
    support = await VideoEncoder.isConfigSupported({
      codec, width: w, height: h, bitrate: 9_000_000, framerate: fps,
    });
  }
  if (!support.supported) throw new Error('此浏览器不支持该画面的视频导出，请改用 GIF');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: w, height: h, frameRate: fps },
    ...(audio ? { audio: audio.config } : {}),
    fastStart: 'in-memory',
  });
  if (audio) {
    for (const [chunk, meta] of audio.chunks) muxer.addAudioChunk(chunk, meta);
  }

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
    if (isVideoBg) await seekVideoTo(state.bgVideo, fc / fps);
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
  return {
    blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }),
    audio: !!audio,
    isVideoBg,
  };
}

async function exportGif() {
  const { GIFEncoder, quantize, applyPalette } = await import('../vendor/gifenc.js');
  const [fw, fh] = fullSize();
  const maxEdge = state.gifEdge || 480;
  const sc = Math.min(1, maxEdge / Math.max(fw, fh));
  const gw = even(fw * sc), gh = even(fh * sc);
  const gsc = gw / fw;
  const total = E.FPS * E.GIF_DURATION;                 // 90 帧
  const s = buildSceneAt(gw, gh, gsc);
  const target = makeTarget(gw, gh);
  const isVideoBg = state.bgKind === 'video' && !!state.bgVideo;
  const vDur = isVideoBg && isFinite(state.bgVideo.duration) && state.bgVideo.duration > 0
    ? state.bgVideo.duration : 0;
  if (isVideoBg) {
    try { state.bgVideo.pause(); } catch (e) {}
  }

  const gif = GIFEncoder();
  let written = 0;
  for (let fc = 0; fc < total; fc++) {
    if (isVideoBg) {
      await seekVideoTo(state.bgVideo, vDur ? (fc / E.FPS) % vDur : 0);
    }
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
  syncBgVideo();
  window.__lastExportError = null;
  clearTimeout(progressHideTimer);
  const controls = $('controls');
  const tabbar = $('tabbar');
  const pcTabs = $('pcTabs');
  const exportBar = $('exportBar');
  const stage = $('stage');
  const textModule = $('textModule');
  closeDrawer();
  controls.setAttribute('inert', '');
  controls.setAttribute('aria-busy', 'true');
  tabbar.setAttribute('inert', '');
  pcTabs.setAttribute('inert', '');
  exportBar.setAttribute('inert', '');
  stage.setAttribute('inert', '');
  textModule.setAttribute('inert', '');
  $('btnPause').disabled = true;
  $('btnExport').disabled = true;
  $('btnExport').textContent = '生成中…';
  phase = 0;
  const wasGif = state.fmt === 'gif';
  const name = outName(wasGif ? 'gif' : 'mp4');
  try {
    const result = wasGif ? { blob: await exportGif() } : await exportMp4();
    const blob = result.blob;
    setProgress(100, '完成');
    await saveBlob(blob, name);
    if (wasGif) toast('GIF 已生成');
    else if (result.isVideoBg && result.audio) toast('视频已生成，已保留原声');
    else if (result.isVideoBg) toast('视频已生成（无原声）');
    else toast('视频已生成');
    progressHideTimer = setTimeout(() => setProgress(null), 1500);
  } catch (ex) {
    console.error(ex);
    window.__lastExportError = (ex && ex.stack) ? String(ex.stack) : String(ex);
    setProgress(null);
    const msg = (ex && /^此浏览器/.test(ex.message || ''))
      ? ex.message : '生成失败，请重试';
    toast(msg);
  } finally {
    exporting = false;
    controls.removeAttribute('inert');
    controls.removeAttribute('aria-busy');
    tabbar.removeAttribute('inert');
    pcTabs.removeAttribute('inert');
    exportBar.removeAttribute('inert');
    stage.removeAttribute('inert');
    textModule.removeAttribute('inert');
    $('btnPause').disabled = false;
    $('btnExport').disabled = false;
    $('btnExport').textContent = '生成并保存';
    state.playing = wasPlaying;         // 尊重导出前的暂停状态
    $('btnPause').textContent = wasPlaying ? '暂停' : '播放';
    syncBgVideo();
    resetPreview();
  }
}

/* ------------------------------------------------ 启动 --- */
function init() {
  loadPrefs();
  applyAntiUi();
  setupCanvas();
  bindUI();
  enhanceAllSelects();
  setActiveTab('font');
  closeDrawer();
  resetPreview();
  tick();

  // 更新预览尺寸标签
  $('sizeLabel').textContent = fullW + ' × ' + fullH;

  window.addEventListener('pagehide', savePrefs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePrefs();
    else syncBgVideo();
  });

  // Service Worker（仅 HTTPS 或本机可用，局域网 IP 下自动跳过）
  if ('serviceWorker' in navigator &&
      (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .then((reg) => { reg.update().catch(() => {}); })
      .catch(() => {});
  }
}
init();
