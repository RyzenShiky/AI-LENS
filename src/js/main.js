import { CameraManager } from "./camera/camera-manager.js";
import { drawHUD, coverTransform } from "./ui/hud-renderer.js";
import {
  OrientationHelper,
  pickDepthProvider,
  GroundPlaneEstimate
} from "./depth/depth-provider.js";
import { depthBadge, slopeConfidence, formatSlope } from "./depth/fusion.js";
import { MODES, ORDER, AutoMode } from "./ui/modes.js";

const video  = document.querySelector("#camera");
const canvas = document.querySelector("#overlay");
const mosaicEl = document.querySelector("#mosaic");
const ctx    = canvas.getContext("2d");
const mctx   = mosaicEl?.getContext("2d");

const camera = new CameraManager(video);
const orient = new OrientationHelper();
const autoMode = new AutoMode();

const startBtn  = document.querySelector("#startButton");
const flipBtn   = document.querySelector("#flipButton");
const layersBtn = document.querySelector("#layersBtn");
const fpsChip   = document.querySelector("#fps");
const banner    = document.querySelector("#hudBanner");
const bannerSub = document.querySelector("#hudBannerSub");
const sheet     = document.querySelector("#sheet");
const onboard   = document.querySelector("#onboard");
const onboardTitle = document.querySelector("#onboardTitle");
const onboardText  = document.querySelector("#onboardText");
const allowBtn  = document.querySelector("#allowCam");
const retryBtn  = document.querySelector("#retryBtn");
const countGrip = document.querySelector("#countGrip");
const countCheck= document.querySelector("#countCheck");
const countReject = document.querySelector("#countReject");
const latencyEl = document.querySelector("#latency");
const engineEl  = document.querySelector("#engineStat");
const depthChip = document.querySelector("#depthChip");
const modeChip  = document.querySelector("#modeChip");
const layersPop = document.querySelector("#layersPop");
const modeSeg   = document.querySelector("#modeSeg");

let worker = null;
let workerReady = false;
let running = false;
let sending = false;
let rvfcHandle = null;
let lastTracks = [];
let lastMeta = { w: 320, h: 180, bw: 40, bh: 22, vw: 320, vh: 180 };
let frameCount = 0, fpsLast = 0, achievedHz = 0;

const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (_) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  },
  getJSON(key, fallback = {}) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const v = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
    } catch (_) { return fallback; }
  }
};

const LAYER_DEFAULTS = { contour: true, labels: true, leader: true, reject: true, mosaic: true };
let layers = { ...LAYER_DEFAULTS, ...store.getJSON("tv_layers") };
let wakeLock = null;
let cssW = 1, cssH = 1;
let mirrorOverlay = false;
let depthProvider = null;
let fontsReady = false;
let dirty = true;
let lastSent = 0;
let renderMs = 0;
let mImg = null;

let modePref = store.get("tv_mode", "auto"); // auto | performance | balanced | quality
if (modePref !== "auto" && !MODES[modePref]) modePref = "auto";
let currentMode = "balanced";
autoMode.reset();
if (modePref !== "auto" && MODES[modePref]) currentMode = modePref;
else currentMode = ORDER[autoMode.i];

const PAL = [[255,45,58,70],[56,182,255,26],[61,255,106,70]];

const ONBOARD = {
  idle: {
    title: "TerrainVision",
    text: "Real-time surface texture map from classical vision. Research demo — not a safety tool."
  },
  denied: {
    title: "Camera permission denied",
    text: "Allow camera access in your browser site settings, then tap Try again."
  },
  lost: {
    title: "Camera disconnected",
    text: "The camera stream ended. Check that no other app is using it, then tap Try again."
  }
};

function setState(s) {
  document.body.dataset.state = s;
  if (s === "denied" || s === "lost") {
    onboard.hidden = false;
    const msg = ONBOARD[s];
    onboardTitle.textContent = msg.title;
    onboardText.textContent = msg.text;
    allowBtn.hidden = true;
    retryBtn.hidden = false;
  } else if (s === "running" || s === "loading") {
    onboard.hidden = true;
  } else if (s === "idle") {
    onboard.hidden = false;
    onboardTitle.textContent = ONBOARD.idle.title;
    onboardText.textContent = ONBOARD.idle.text;
    allowBtn.hidden = false;
    retryBtn.hidden = true;
  }
}

function setBanner(main, sub) {
  banner.textContent = main;
  bannerSub.textContent = sub;
}

function updateModeChip() {
  if (!modeChip) return;
  const cfg = MODES[currentMode];
  const tag = modePref === "auto" ? `AUTO · ${currentMode.slice(0, 3).toUpperCase()}` : currentMode.slice(0, 4).toUpperCase();
  modeChip.textContent = `${tag} · ${cfg.hz}Hz`;
}

function applyMode(name) {
  if (!MODES[name]) return;
  currentMode = name;
  updateModeChip();
  resizeCanvas();
  layoutMosaic(lastMeta.vw || 320, lastMeta.vh || 180);
  worker?.postMessage({ type: "reset" });
  dirty = true;
}

function effectiveLayers() {
  return {
    ...layers,
    contour: layers.contour !== false && MODES[currentMode].contour
  };
}

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  cssW = Math.max(1, r.width);
  cssH = Math.max(1, r.height);
  const cfg = MODES[currentMode];
  const dpr = Math.min(cfg.dpr, window.devicePixelRatio || 1);
  dirty = true;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutMosaic(lastMeta.vw || 320, lastMeta.vh || 180);
}

function updateMosaic(cls, bw, bh) {
  if (!mosaicEl || !mctx || !cls) return;
  if (mosaicEl.width !== bw || mosaicEl.height !== bh) {
    mosaicEl.width = bw;
    mosaicEl.height = bh;
    mImg = mctx.createImageData(bw, bh);
  }
  if (!mImg) mImg = mctx.createImageData(bw, bh);
  const d = mImg.data;
  for (let i = 0; i < cls.length; i++) {
    const p = PAL[cls[i]] || PAL[1];
    const o = i * 4;
    d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = p[3];
  }
  mctx.putImageData(mImg, 0, 0);
}

function layoutMosaic(vw, vh) {
  if (!mosaicEl) return;
  const ct = coverTransform(cssW, cssH, vw, vh);
  Object.assign(mosaicEl.style, {
    left: ct.ox + "px",
    top: ct.oy + "px",
    width: vw * ct.s + "px",
    height: vh * ct.s + "px",
    transform: mirrorOverlay ? "scaleX(-1)" : "none"
  });
  mosaicEl.hidden = layers.mosaic === false;
}

const ro = new ResizeObserver(() => resizeCanvas());
ro.observe(canvas);
window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 200));

async function ensureFonts() {
  if (fontsReady) return;
  try {
    await Promise.all([
      document.fonts.load("11px 'Share Tech Mono'"),
      document.fonts.load("700 22px Silkscreen")
    ]);
  } catch (_) {}
  fontsReady = true;
}

function initWorker() {
  if (worker && workerReady) return Promise.resolve();
  if (worker) {
    try { worker.terminate(); } catch (_) {}
    worker = null;
    workerReady = false;
  }
  return new Promise((resolve, reject) => {
    worker = new Worker(new URL("./vision/vision-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "ready") {
        workerReady = true;
        engineEl.textContent = msg.simdLoaded ? "ONLINE · SIMD" : "ONLINE";
        resolve();
      } else if (msg.type === "error") {
        console.error(msg.message);
        engineEl.textContent = "ERROR";
        sending = false;
        if (!workerReady) {
          try { worker.terminate(); } catch (_) {}
          worker = null;
          reject(new Error(msg.message));
        }
      } else if (msg.type === "result") {
        sending = false;
        lastTracks = msg.tracked;
        lastMeta = {
          w: msg.w, h: msg.h, bw: msg.bw, bh: msg.bh,
          vw: msg.vw, vh: msg.vh,
          cls: msg.cls || null,
          tHi: msg.tHi, tLo: msg.tLo
        };
        countGrip.textContent = msg.counts.GRIP || 0;
        countCheck.textContent = msg.counts.CHECK || 0;
        countReject.textContent = msg.counts.REJECT || 0;
        latencyEl.textContent = `${msg.ms.toFixed(1)} ms`;
        if (depthChip) {
          const mode = msg.depthMode || "est";
          const conf = msg.slopeConf ?? 0;
          const fmt = formatSlope(msg.slopeDeg, conf, mode);
          const badge = depthBadge(mode);
          depthChip.textContent = fmt ? `${badge} ${fmt.text}` : badge;
          depthChip.dataset.tier = fmt?.tier || "low";
        }
        setBanner("SURFACE TEXTURE MAP", "RELATIVE TO SCENE");
        dirty = true;
        if (msg.cls && msg.bw && msg.bh) updateMosaic(msg.cls, msg.bw, msg.bh);
        layoutMosaic(msg.vw || 320, msg.vh || 180);

        frameCount++;
        const now = performance.now();
        if (now - fpsLast >= 1000) {
          achievedHz = frameCount;
          fpsChip.textContent = `${frameCount} FPS`;
          frameCount = 0;
          fpsLast = now;
        }

        if (modePref === "auto") {
          const next = autoMode.update({
            workerMs: msg.ms,
            renderMs,
            achievedHz
          });
          if (next !== currentMode) applyMode(next);
        }
      }
    };
    worker.onerror = (e) => {
      sending = false;
      engineEl.textContent = "ERROR";
      if (!workerReady) {
        try { worker.terminate(); } catch (_) {}
        worker = null;
        reject(e);
      }
    };
    worker.postMessage({ type: "init" });
  });
}

function cancelRvfc() {
  if (rvfcHandle != null && video.cancelVideoFrameCallback) {
    try { video.cancelVideoFrameCallback(rvfcHandle); } catch (_) {}
  }
  rvfcHandle = null;
}

function scheduleFrame() {
  if (!running) return;
  const tick = async () => {
    if (!running) return;
    const now = performance.now();
    const hz = MODES[currentMode].hz;
    if (now - lastSent >= 1000 / hz) {
      lastSent = now;
      await processFrame();
    }
    scheduleFrame();
  };
  if (video.requestVideoFrameCallback) {
    rvfcHandle = video.requestVideoFrameCallback(tick);
  } else {
    requestAnimationFrame(tick);
  }
}

async function processFrame() {
  if (!running || sending || video.videoWidth < 16) return;
  if (document.hidden) return;

  sending = true;
  try {
    let slopeDeg = null, slopeConf = 0, depthId = "EST", depthMode = "est";
    if (depthProvider) {
      const d = await depthProvider.depth();
      slopeDeg = d.slopeDeg;
      depthId = depthProvider.id;
      depthMode = depthId === "XR" ? "fused" : depthId === "AI" ? "ai" : "est";
      slopeConf = slopeConfidence({
        mode: depthMode,
        inlier: d.inlierRatio,
        gyroMag: d.gyroMag ?? orient.gyroMag ?? null,
        points: d.points ?? null,
        normalStd: d.normalStd ?? null
      });
      if (typeof d.slopeConf === "number") {
        slopeConf = Math.min(slopeConf, d.slopeConf);
      }
    }
    const landscape = cssW > cssH;
    const cols = landscape ? 4 : 3;
    const rows = landscape ? 3 : 4;
    const longSide = MODES[currentMode].longSide;
    const vh = video.videoHeight || 180;
    const vw = video.videoWidth || 320;
    const s = longSide / Math.max(vw, vh);
    const targetW = Math.max(16, Math.round(vw * s));
    const targetH = Math.max(16, Math.round(vh * s));
    let bitmap;
    try {
      bitmap = await createImageBitmap(video, {
        resizeWidth: targetW,
        resizeHeight: targetH,
        resizeQuality: "low"
      });
    } catch (_) {
      bitmap = await createImageBitmap(video);
    }
    worker.postMessage({
      type: "frame",
      bitmap,
      slopeDeg,
      slopeConf,
      depthId,
      depthMode,
      cols,
      rows,
      longSide
    }, [bitmap]);
  } catch (e) {
    sending = false;
    console.error(e);
  }
}

function renderLoop() {
  canvas.style.transform = mirrorOverlay ? "scaleX(-1)" : "none";
  if (mosaicEl) mosaicEl.style.transform = mirrorOverlay ? "scaleX(-1)" : "none";
  if (dirty && fontsReady) {
    const t0 = performance.now();
    drawHUD(ctx, lastTracks, lastMeta, effectiveLayers(), cssW, cssH, mirrorOverlay);
    renderMs = 0.9 * renderMs + 0.1 * (performance.now() - t0);
    dirty = false;
  }
  requestAnimationFrame(renderLoop);
}

try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      if (e.duration > 50) console.warn("[longtask]", e.duration | 0, "ms");
    }
  }).observe({ entryTypes: ["longtask"] });
} catch (_) {}

async function acquireWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
    wakeLock?.addEventListener?.("release", () => { wakeLock = null; });
  } catch (_) {}
}

async function releaseWakeLock() {
  try { await wakeLock?.release?.(); } catch (_) {}
  wakeLock = null;
}

async function start() {
  if (running || camera.isStarting) return;
  setState("loading");
  startBtn.dataset.running = "false";
  try {
    // iOS: izin sensor harus diminta langsung dari gesture pengguna
    const orientPerm = orient.start();
    await ensureFonts();
    const orientOk = await orientPerm;
    if (!orientOk) console.warn("Motion/orientation permission denied");
    depthProvider = await pickDepthProvider(orient);
    if (!depthProvider) depthProvider = new GroundPlaneEstimate(orient);

    await initWorker();
    const res = await camera.start();
    mirrorOverlay = res.facingMode === "user";
    running = true;
    sending = false;
    fpsLast = performance.now();
    frameCount = 0;
    startBtn.dataset.running = "true";
    setState("running");
    setBanner("SURFACE TEXTURE MAP", "RELATIVE TO SCENE");
    if (depthChip) depthChip.textContent = `DEPTH:${depthProvider.id}`;
    updateModeChip();
    worker.postMessage({ type: "reset" });
    cancelRvfc();
    scheduleFrame();
    await acquireWakeLock();
  } catch (e) {
    console.error(e);
    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "SecurityError" || /Permission|denied/i.test(String(e))) {
      setState("denied");
    } else {
      setState("lost");
    }
    startBtn.dataset.running = "false";
  }
}

function stop() {
  running = false;
  sending = false;
  cancelRvfc();
  camera.stop();
  lastTracks = [];
  mirrorOverlay = false;
  startBtn.dataset.running = "false";
  setState("idle");
  setBanner("SYSTEM STANDBY", "READY");
  fpsChip.textContent = "0 FPS";
  worker?.postMessage({ type: "reset" });
  releaseWakeLock();
}

camera.onTrackEnded = () => {
  if (!running) return;
  running = false;
  cancelRvfc();
  releaseWakeLock();
  setState("lost");
  startBtn.dataset.running = "false";
};

startBtn.addEventListener("click", () => {
  if (running) stop();
  else start();
});

flipBtn.addEventListener("click", async () => {
  if (!running || camera.isStarting) return;
  try {
    const res = await camera.flip();
    mirrorOverlay = res.facingMode === "user";
    layoutMosaic(lastMeta.vw || 320, lastMeta.vh || 180);
    worker?.postMessage({ type: "reset" });
  } catch (e) {
    console.error(e);
    stop();
    setState("lost");
  }
});

allowBtn?.addEventListener("click", () => start());
retryBtn?.addEventListener("click", () => start());

sheet.querySelector(".grab")?.addEventListener("click", () => {
  sheet.dataset.open = sheet.dataset.open === "true" ? "false" : "true";
});

layersBtn?.addEventListener("click", () => {
  layersPop.hidden = !layersPop.hidden;
});

layersPop?.querySelectorAll("input[type=checkbox]").forEach(inp => {
  inp.checked = layers[inp.name] !== false;
  inp.addEventListener("change", () => {
    layers[inp.name] = inp.checked;
    store.set("tv_layers", JSON.stringify(layers));
    if (inp.name === "mosaic") layoutMosaic(lastMeta.vw || 320, lastMeta.vh || 180);
    dirty = true;
  });
});

modeSeg?.querySelectorAll("button[data-mode]").forEach(btn => {
  btn.setAttribute("aria-pressed", btn.dataset.mode === modePref ? "true" : "false");
  btn.addEventListener("click", () => {
    modePref = btn.dataset.mode;
    store.set("tv_mode", modePref);
    modeSeg.querySelectorAll("button[data-mode]").forEach(b => {
      b.setAttribute("aria-pressed", b.dataset.mode === modePref ? "true" : "false");
    });
    if (modePref === "auto") {
      autoMode.reset();
      applyMode(ORDER[autoMode.i]);
    } else {
      applyMode(modePref);
    }
  });
});

window.addEventListener("pagehide", (e) => {
  if (running) stop();
  orient.stop();
  if (!e.persisted && worker) {
    worker.terminate();
    worker = null;
    workerReady = false;
  }
});

setState("idle");
setBanner("TERRAINVISION", "TAP TO START");
updateModeChip();
resizeCanvas();
ensureFonts().then(() => { fontsReady = true; dirty = true; });
renderLoop();
