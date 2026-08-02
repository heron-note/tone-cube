/**
 * Tone Cube — mobile multitouch pad
 * Locked row: hold + horizontal drag = seamless pitch
 * Unlocked row: horizontal swipe = Rubik shift
 * Per-row timbre & lock · fixed 12 columns · handedness flip
 */

const NOTE_NAMES = ["ド", "ド♯", "レ", "レ♯", "ミ", "ファ", "ファ♯", "ソ", "ソ♯", "ラ", "ラ♯", "シ"];
const PC_HUE = [8, 28, 48, 68, 95, 145, 170, 195, 220, 265, 300, 335];

const TIMBRES = [
  { id: "pure", name: "ピュア" },
  { id: "soft", name: "ソフト" },
  { id: "lead", name: "リード" },
  { id: "square", name: "スクエア" },
  { id: "pad", name: "パッド" },
  { id: "brass", name: "ブラス" },
  { id: "bass", name: "ベース" },
  { id: "bell", name: "ベル" },
];

const BASE_MIDI = 60;
const ROW_COUNT = 8;
const COLS = 12;
const AXIS_LOCK = 12;
const OCT_STEP_PX = 28;
const CELL_GAP = 2;

const state = {
  cols: COLS,
  octaves: Array(ROW_COUNT).fill(0),
  shifts: Array(ROW_COUNT).fill(0),
  timbres: Array(ROW_COUNT).fill(0),
  locked: Array(ROW_COUNT).fill(true),
  dialAngles: Array(ROW_COUNT).fill(0),
  lefty: false,
  dialsFolded: true,
};

/** @type {Map<number|string, Voice>} */
const activeVoices = new Map();

/** @type {Map<number|string, {
 *   row: number,
 *   xNorm: number,
 *   mode: 'pending'|'play'|'shift'|'octave',
 *   startX: number,
 *   startY: number,
 *   lastY: number,
 *   octAcc: number,
 *   shiftDx: number,
 * }>} */
const activeTouches = new Map();

let audioCtx = null;
let masterGain = null;
/** iOS: headphone unplug can leave a dead route — rebuild on next gesture. */
let audioNeedsRebuild = false;

const cubeEl = document.getElementById("cube");
const appEl = document.querySelector(".app");
const handBtn = document.getElementById("handedness");
const foldBtn = document.getElementById("fold-dials");

// ——— Audio ———

function markAudioDirty() {
  audioNeedsRebuild = true;
}

async function teardownAudio() {
  for (const id of [...activeVoices.keys()]) {
    const voice = activeVoices.get(id);
    if (voice) voice.dispose();
    activeVoices.delete(id);
  }
  if (audioCtx) {
    try {
      await audioCtx.close();
    } catch {
      /* */
    }
  }
  audioCtx = null;
  masterGain = null;
}

function buildAudioGraph(ctx) {
  const gain = ctx.createGain();
  gain.gain.value = 0.4;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.003;
  comp.release.value = 0.12;
  gain.connect(comp).connect(ctx.destination);
  masterGain = gain;
}

async function ensureAudio({ force = false } = {}) {
  if (force || audioNeedsRebuild || !audioCtx || audioCtx.state === "closed") {
    await teardownAudio();
    audioNeedsRebuild = false;
  }

  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    buildAudioGraph(audioCtx);
    audioCtx.addEventListener("statechange", () => {
      if (audioCtx?.state === "interrupted") markAudioDirty();
    });
  }

  if (audioCtx.state !== "running") {
    try {
      await audioCtx.resume();
    } catch {
      /* */
    }
  }

  const ok = audioCtx.state === "running";
  const gate = document.getElementById("audio-gate");
  if (gate) {
    gate.dataset.on = ok ? "1" : "0";
    gate.textContent = ok ? "音ON" : "音を有効化";
  }
  return ok;
}

function bindAudioRouteWatchers() {
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    markAudioDirty();
  });
}

function midiToFreq(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function colorFor(pc, octave) {
  const hue = PC_HUE[((pc % 12) + 12) % 12];
  const light = 42 + octave * 10;
  const sat = 62 - Math.abs(octave) * 4;
  return `hsl(${hue} ${Math.max(40, sat)}% ${Math.min(68, Math.max(22, light))}%)`;
}

class Voice {
  constructor(ctx, timbreId, freq) {
    this.ctx = ctx;
    this.timbreId = timbreId;
    this.nodes = [];
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(masterGain);
    this.filter = null;
    this.mod = null;
    this.modGain = null;
    this._build(timbreId, freq);
    const now = ctx.currentTime;
    this.gain.gain.setValueAtTime(0, now);
    this.gain.gain.linearRampToValueAtTime(this._peak(), now + 0.02);
  }

  _peak() {
    if (this.timbreId === "pad") return 0.22;
    if (this.timbreId === "bass") return 0.38;
    if (this.timbreId === "bell") return 0.28;
    return 0.3;
  }

  _osc(type, freq, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    o.detune.value = detune;
    o.start();
    this.nodes.push(o);
    return o;
  }

  _build(id, freq) {
    const ctx = this.ctx;
    if (id === "pure") {
      this._osc("sine", freq).connect(this.gain);
    } else if (id === "soft") {
      this._osc("triangle", freq).connect(this.gain);
    } else if (id === "square") {
      const o = this._osc("square", freq);
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = Math.min(4200, freq * 6);
      this.filter = f;
      o.connect(f).connect(this.gain);
    } else if (id === "lead") {
      const o = this._osc("sawtooth", freq);
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = Math.min(5200, freq * 8);
      f.Q.value = 6;
      this.filter = f;
      o.connect(f).connect(this.gain);
    } else if (id === "pad") {
      const merge = ctx.createGain();
      merge.gain.value = 0.34;
      this._osc("sawtooth", freq, -8).connect(merge);
      this._osc("sawtooth", freq, 8).connect(merge);
      this._osc("triangle", freq, 0).connect(merge);
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 1800;
      this.filter = f;
      merge.connect(f).connect(this.gain);
    } else if (id === "brass") {
      const o = this._osc("sawtooth", freq);
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = freq * 3.2;
      f.Q.value = 2;
      this.filter = f;
      o.connect(f).connect(this.gain);
      const now = ctx.currentTime;
      f.frequency.setValueAtTime(freq * 1.2, now);
      f.frequency.linearRampToValueAtTime(freq * 4.5, now + 0.12);
    } else if (id === "bass") {
      const o = this._osc("sine", freq);
      const o2 = this._osc("sawtooth", freq);
      const g2 = ctx.createGain();
      g2.gain.value = 0.18;
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = 420;
      this.filter = f;
      o.connect(this.gain);
      o2.connect(g2).connect(f).connect(this.gain);
    } else if (id === "bell") {
      const car = this._osc("sine", freq);
      const mod = this._osc("sine", freq * 2.01);
      const modGain = ctx.createGain();
      modGain.gain.value = freq * 1.4;
      this.mod = mod;
      this.modGain = modGain;
      mod.connect(modGain);
      modGain.connect(car.frequency);
      car.connect(this.gain);
    }
  }

  setFrequency(freq, glideSec = 0.018) {
    const now = this.ctx.currentTime;
    const tau = Math.max(0.004, glideSec / 3);
    for (const n of this.nodes) {
      if (n.frequency) {
        n.frequency.cancelScheduledValues(now);
        n.frequency.setTargetAtTime(freq, now, tau);
      }
    }
    if (this.timbreId === "bell" && this.mod && this.modGain) {
      this.mod.frequency.cancelScheduledValues(now);
      this.mod.frequency.setTargetAtTime(freq * 2.01, now, tau);
      this.modGain.gain.cancelScheduledValues(now);
      this.modGain.gain.setTargetAtTime(freq * 1.4, now, tau);
    }
    if (this.filter && (this.timbreId === "lead" || this.timbreId === "square")) {
      const target =
        this.timbreId === "lead"
          ? Math.min(5200, freq * 8)
          : Math.min(4200, freq * 6);
      this.filter.frequency.setTargetAtTime(target, now, 0.04);
    }
  }

  release() {
    const now = this.ctx.currentTime;
    const rel = this.timbreId === "pad" ? 0.35 : this.timbreId === "bell" ? 0.45 : 0.08;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(Math.max(this.gain.gain.value, 0.001), now);
    this.gain.gain.exponentialRampToValueAtTime(0.0001, now + rel);
    setTimeout(() => this.dispose(), rel * 1000 + 40);
  }

  dispose() {
    for (const n of this.nodes) {
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* */
      }
    }
    try {
      this.gain.disconnect();
    } catch {
      /* */
    }
    this.nodes = [];
  }
}

function pitchAt(row, xNorm) {
  const midi = BASE_MIDI + state.octaves[row] * 12 + state.shifts[row] + xNorm;
  return { midi, freq: midiToFreq(midi) };
}

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function formatOct(o) {
  if (o === 0) return "0";
  return o > 0 ? `+${o}` : `${o}`;
}

function angleForTimbre(index) {
  return (index / TIMBRES.length) * 360;
}

// ——— DOM / cube ———

function makeCell(row, col, cellW) {
  const cell = document.createElement("div");
  cell.className = "cell";
  cell.dataset.row = String(row);
  cell.dataset.col = String(((col % state.cols) + state.cols) % state.cols);
  cell.style.flex = `0 0 ${cellW}px`;
  cell.style.width = `${cellW}px`;
  const label = document.createElement("span");
  label.className = "note-label";
  cell.appendChild(label);
  const midi = BASE_MIDI + state.octaves[row] * 12 + state.shifts[row] + col;
  const pc = ((midi % 12) + 12) % 12;
  cell.style.background = colorFor(pc, state.octaves[row]);
  label.textContent = NOTE_NAMES[pc];
  return cell;
}

function cellPitchWidth(viewport) {
  const inner = viewport.clientWidth - CELL_GAP * 2;
  const cellW = (inner - CELL_GAP * (state.cols - 1)) / state.cols;
  return cellW + CELL_GAP;
}

function trackFor(row) {
  return cubeEl.querySelector(`.cells-track[data-row="${row}"]`);
}

function viewportFor(row) {
  return cubeEl.querySelector(`.cells-viewport[data-row="${row}"]`);
}

function rowEl(row) {
  return cubeEl.querySelector(`.row[data-row="${row}"]`);
}

function rebuildTrack(row) {
  const track = trackFor(row);
  const viewport = viewportFor(row);
  if (!track || !viewport) return;
  track.classList.remove("is-animating");
  track.innerHTML = "";

  const step = cellPitchWidth(viewport);
  const cellW = step - CELL_GAP;

  for (let c = -state.cols; c < state.cols * 2; c++) {
    track.appendChild(makeCell(row, c, cellW));
  }

  const baseX = -state.cols * step;
  track.dataset.baseX = String(baseX);
  track.style.transform = `translateX(${baseX}px)`;
}

function refreshOctLabel(row) {
  const el = cubeEl.querySelector(`.row[data-row="${row}"] .oct-value`);
  if (!el) return;
  el.textContent = formatOct(state.octaves[row]);
  el.classList.remove("is-flash");
  void el.offsetWidth;
  el.classList.add("is-flash");
}

function refreshRowChrome(row) {
  const el = rowEl(row);
  if (!el) return;
  el.classList.toggle("is-locked", state.locked[row]);
  const meta = el.querySelector(".row-meta");
  if (meta) {
    const locked = state.locked[row];
    meta.setAttribute("aria-pressed", locked ? "true" : "false");
    meta.title = locked
      ? `行${row + 1}: ロック中（タップで解除） / オクターブ ${formatOct(state.octaves[row])}`
      : `行${row + 1}: 解除中（タップでロック） / オクターブ ${formatOct(state.octaves[row])}`;
    meta.setAttribute(
      "aria-label",
      locked
        ? `行${row + 1}のロックを解除。オクターブ ${formatOct(state.octaves[row])}`
        : `行${row + 1}をロック。オクターブ ${formatOct(state.octaves[row])}`
    );
  }
  const face = el.querySelector(".row-dial .dial-face");
  if (face) face.style.transform = `rotate(${state.dialAngles[row]}deg)`;
}

function refreshRowVisual(row) {
  refreshOctLabel(row);
  rebuildTrack(row);
  refreshRowChrome(row);
  for (const [id, meta] of activeTouches) {
    if (meta.row === row && meta.mode === "play") {
      const voice = activeVoices.get(id);
      if (voice) voice.setFrequency(pitchAt(row, meta.xNorm).freq);
    }
  }
  updateGlows();
}

function setRowLock(row, locked) {
  state.locked[row] = locked;
  refreshRowChrome(row);
}

function setRowTimbre(row, index, angle) {
  state.timbres[row] = clamp(index, 0, TIMBRES.length - 1);
  state.dialAngles[row] =
    typeof angle === "number" ? angle : angleForTimbre(state.timbres[row]);
  refreshRowChrome(row);
}

function setLefty(lefty) {
  state.lefty = lefty;
  appEl?.classList.toggle("is-lefty", lefty);
  if (handBtn) {
    handBtn.setAttribute("aria-pressed", lefty ? "true" : "false");
    handBtn.textContent = lefty ? "左利き" : "右利き";
  }
  requestAnimationFrame(() => {
    for (let r = 0; r < ROW_COUNT; r++) rebuildTrack(r);
  });
}

function setDialsFolded(folded) {
  state.dialsFolded = folded;
  appEl?.classList.toggle("dials-folded", folded);
  if (foldBtn) {
    foldBtn.setAttribute("aria-pressed", folded ? "true" : "false");
    foldBtn.textContent = folded ? "音色出す" : "音色隠す";
  }
  requestAnimationFrame(() => {
    for (let r = 0; r < ROW_COUNT; r++) rebuildTrack(r);
  });
}

function buildCube() {
  if (!cubeEl) return;
  cubeEl.innerHTML = "";
  for (let r = 0; r < ROW_COUNT; r++) {
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.row = String(r);

    const meta = document.createElement("button");
    meta.type = "button";
    meta.className = "row-meta";
    meta.innerHTML = `
      <span class="lock-ico" aria-hidden="true"></span>
      <span class="oct-value">${formatOct(state.octaves[r])}</span>
    `;
    meta.setAttribute("aria-pressed", state.locked[r] ? "true" : "false");
    meta.addEventListener("click", (e) => {
      e.stopPropagation();
      setRowLock(r, !state.locked[r]);
    });

    const dial = document.createElement("div");
    dial.className = "row-dial";
    dial.dataset.row = String(r);
    dial.setAttribute("role", "slider");
    dial.setAttribute("aria-label", `行${r + 1}の音色`);
    dial.setAttribute("aria-valuemin", "0");
    dial.setAttribute("aria-valuemax", String(TIMBRES.length - 1));
    dial.setAttribute("aria-valuenow", String(state.timbres[r]));
    dial.innerHTML = `<div class="dial-face"><span class="dial-tick"></span></div>`;
    dial.querySelector(".dial-face").style.transform = `rotate(${state.dialAngles[r]}deg)`;
    bindRowDial(dial, r);

    const viewport = document.createElement("div");
    viewport.className = "cells-viewport";
    viewport.dataset.row = String(r);
    const track = document.createElement("div");
    track.className = "cells-track";
    track.dataset.row = String(r);
    viewport.appendChild(track);

    row.append(meta, dial, viewport);
    cubeEl.appendChild(row);
    rebuildTrack(r);
    bindRowGestures(viewport, r);
    refreshRowChrome(r);
  }
}

// ——— Gestures ———

function xNormFromClientX(viewport, clientX) {
  const rect = viewport.getBoundingClientRect();
  const x = clamp(clientX - rect.left, 0, rect.width - 0.001);
  return (x / rect.width) * state.cols;
}

function stopVoice(id, immediate = false) {
  const voice = activeVoices.get(id);
  if (voice) {
    if (immediate) voice.dispose();
    else voice.release();
    activeVoices.delete(id);
  }
}

function startPlay(id, row, xNorm) {
  stopVoice(id, true);
  if (!audioCtx) return;
  const voice = new Voice(audioCtx, TIMBRES[state.timbres[row]].id, pitchAt(row, xNorm).freq);
  activeVoices.set(id, voice);
  updateGlows();
}

function pointerDown(id, row, viewport, x, y) {
  const xNorm = xNormFromClientX(viewport, x);
  activeTouches.set(id, {
    row,
    xNorm,
    mode: "pending",
    startX: x,
    startY: y,
    lastY: y,
    octAcc: 0,
    shiftDx: 0,
  });
  const tryPlay = () => {
    const meta = activeTouches.get(id);
    if (!meta || meta.mode !== "pending") return;
    if (!audioCtx || audioCtx.state !== "running") return;
    meta.mode = "play";
    startPlay(id, meta.row, meta.xNorm);
  };
  // Always go through ensureAudio on gesture — rebuilds after headphone unplug on iOS
  void ensureAudio().then(tryPlay);
}

function pointerMove(id, x, y) {
  const meta = activeTouches.get(id);
  if (!meta) return;

  const dx = x - meta.startX;
  const dy = y - meta.startY;
  const locked = state.locked[meta.row];

  if (meta.mode === "play" || meta.mode === "pending") {
    if (
      !locked &&
      Math.abs(dx) > AXIS_LOCK &&
      Math.abs(dx) > Math.abs(dy) * 1.15
    ) {
      meta.mode = "shift";
      stopVoice(id);
      activeVoices.delete(id);
      meta.shiftDx = dx;
      applyShiftDrag(meta.row, dx);
      updateGlows();
      return;
    }
    if (Math.abs(dy) > AXIS_LOCK && Math.abs(dy) > Math.abs(dx) * 1.15) {
      meta.mode = "octave";
      stopVoice(id);
      activeVoices.delete(id);
      meta.octAcc = 0;
      meta.lastY = y;
      updateGlows();
      return;
    }
    if (meta.mode === "pending") return;

    const vp = viewportFor(meta.row);
    if (!vp) return;
    meta.xNorm = xNormFromClientX(vp, x);
    const voice = activeVoices.get(id);
    if (voice) voice.setFrequency(pitchAt(meta.row, meta.xNorm).freq, 0.012);
    updateGlows();
    return;
  }

  if (meta.mode === "shift") {
    meta.shiftDx = dx;
    applyShiftDrag(meta.row, dx);
    return;
  }

  if (meta.mode === "octave") {
    const stepDy = y - meta.lastY;
    meta.octAcc += stepDy;
    meta.lastY = y;
    while (meta.octAcc <= -OCT_STEP_PX) {
      meta.octAcc += OCT_STEP_PX;
      changeOctave(meta.row, 1);
    }
    while (meta.octAcc >= OCT_STEP_PX) {
      meta.octAcc -= OCT_STEP_PX;
      changeOctave(meta.row, -1);
    }
  }
}

function pointerUp(id) {
  const meta = activeTouches.get(id);
  if (!meta) return;

  if (meta.mode === "shift") {
    commitShiftDrag(meta.row, meta.shiftDx);
  } else if (meta.mode === "play" || meta.mode === "pending") {
    const voice = activeVoices.get(id);
    if (voice) voice.release();
    activeVoices.delete(id);
  }

  activeTouches.delete(id);
  updateGlows();
}

function bindRowGestures(viewport, row) {
  viewport.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) pointerDown(t.identifier, row, viewport, t.clientX, t.clientY);
    },
    { passive: false }
  );
  viewport.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) pointerMove(t.identifier, t.clientX, t.clientY);
    },
    { passive: false }
  );
  viewport.addEventListener(
    "touchend",
    (e) => {
      for (const t of e.changedTouches) pointerUp(t.identifier);
    },
    { passive: true }
  );
  viewport.addEventListener(
    "touchcancel",
    (e) => {
      for (const t of e.changedTouches) pointerUp(t.identifier);
    },
    { passive: true }
  );
  viewport.addEventListener("mousedown", (e) => {
    e.preventDefault();
    pointerDown("mouse", row, viewport, e.clientX, e.clientY);
  });
}

function applyShiftDrag(row, dx) {
  const track = trackFor(row);
  if (!track) return;
  const base = Number(track.dataset.baseX || 0);
  track.classList.remove("is-animating");
  track.style.transform = `translateX(${base + dx}px)`;
}

function commitShiftDrag(row, dx) {
  const viewport = viewportFor(row);
  const track = trackFor(row);
  if (!viewport || !track) return;

  const step = cellPitchWidth(viewport);
  const base = Number(track.dataset.baseX || 0);
  const steps = Math.round(dx / step);
  const targetX = base + steps * step;

  track.classList.add("is-animating");
  track.style.transform = `translateX(${targetX}px)`;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    track.removeEventListener("transitionend", finish);
    state.shifts[row] -= steps;
    rebuildTrack(row);
    updateGlows();
  };

  track.addEventListener("transitionend", finish);
  setTimeout(finish, 220);
}

function changeOctave(row, dir) {
  state.octaves[row] = clamp(state.octaves[row] + dir, -3, 4);
  refreshRowVisual(row);
}

function updateGlows() {
  const lit = new Set();
  for (const meta of activeTouches.values()) {
    if (meta.mode !== "play") continue;
    const col = clamp(Math.floor(meta.xNorm), 0, state.cols - 1);
    lit.add(`${meta.row}:${col}`);
  }
  cubeEl.querySelectorAll(".cell").forEach((cell) => {
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    cell.classList.toggle("is-active", lit.has(key));
  });
}

// ——— Per-row dials ———

function bindRowDial(el, row) {
  const face = el.querySelector(".dial-face");
  let dragging = false;
  let lastAngle = 0;
  let liveAngle = 0;

  const angleAt = (clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(clientY - cy, clientX - cx) * 180) / Math.PI;
  };

  const onStart = (x, y) => {
    dragging = true;
    lastAngle = angleAt(x, y);
    liveAngle = state.dialAngles[row];
    face.style.transition = "none";
  };

  const onMove = (x, y) => {
    if (!dragging) return;
    const a = angleAt(x, y);
    let delta = a - lastAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    lastAngle = a;
    liveAngle = (liveAngle + delta + 360) % 360;
    face.style.transform = `rotate(${liveAngle}deg)`;
    const idx = Math.round((liveAngle / 360) * TIMBRES.length) % TIMBRES.length;
    state.timbres[row] = idx;
    state.dialAngles[row] = liveAngle;
    el.setAttribute("aria-valuenow", String(idx));
    el.setAttribute("aria-valuetext", TIMBRES[idx].name);
  };

  const onEnd = () => {
    if (!dragging) return;
    dragging = false;
    face.style.transition = "";
    const idx = Math.round((liveAngle / 360) * TIMBRES.length) % TIMBRES.length;
    setRowTimbre(row, idx, angleForTimbre(idx));
    el.setAttribute("aria-valuenow", String(idx));
    el.setAttribute("aria-valuetext", TIMBRES[idx].name);
  };

  el.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.changedTouches[0];
      onStart(t.clientX, t.clientY);
    },
    { passive: false }
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      onMove(t.clientX, t.clientY);
    },
    { passive: false }
  );
  el.addEventListener("touchend", onEnd, { passive: true });
  el.addEventListener("touchcancel", onEnd, { passive: true });

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onStart(e.clientX, e.clientY);
    const move = (ev) => onMove(ev.clientX, ev.clientY);
    const up = () => {
      onEnd();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

// ——— Boot ———

buildCube();
setDialsFolded(state.dialsFolded);
setLefty(state.lefty);

handBtn?.addEventListener("click", () => setLefty(!state.lefty));
foldBtn?.addEventListener("click", () => setDialsFolded(!state.dialsFolded));

document.getElementById("audio-gate")?.addEventListener("click", () => {
  void ensureAudio({ force: true });
});

document.body.addEventListener(
  "touchmove",
  (e) => {
    e.preventDefault();
  },
  { passive: false }
);

bindAudioRouteWatchers();

window.addEventListener("mousemove", (e) => {
  if (!activeTouches.has("mouse")) return;
  pointerMove("mouse", e.clientX, e.clientY);
});
window.addEventListener("mouseup", () => {
  if (!activeTouches.has("mouse")) return;
  pointerUp("mouse");
});
