import { CameraManager } from "./camera/camera-manager.js";
import { drawHUD } from "./ui/hud-renderer.js";
import {
  OrientationHelper,
  pickDepthProvider,
  GroundPlaneEstimate
} from "./depth/depth-provider.js";
import { depthBadge, slopeConfidence, formatSlope } from "./depth/fusion.js";

const video  = document.querySelector("#camera");
const canvas = document.querySelector("#overlay");
const ctx    = canvas.getContext("2d");

const camera = new CameraManager(video);
const orient = new OrientationHelper();

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
const layersPop = document.querySelector("#layersPop");

let worker = null;
let workerReady = false;
let running = false;
let sending = false;
let rvfcHandle = null;
let lastTracks = [];
let lastMeta = { w: 320, h: 180, bw: 40, bh: 22, vw: 320, vh: 180 };
let frameCount = 0, fpsLast = 0;
const LAYER_DEFAULTS = { contour: true, labels: true, leader: true, reject: true, mosaic: true };
let layers = { ...LAYER_DEFAULTS, ...JSON.parse(localStorage.getItem("tv_layers") || "{}") };
let wakeLock = null;
let cssW = 1, cssH = 1;
let mirrorOverlay = false;
let depthProvider = null;
let fontsReady = false;

const ONBOARD = {
  idle: {
    title: "TerrainVision",
    text: "Real-time foothold cues from classical vision. This is a research demo, not a climbing or safety tool."
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

function resizeCanvas() {
  const r = canvas.getBoundingClientRect();
  cssW = Math.max(1, r.width);
  cssH = Math.max(1, r.height);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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

        const grips = msg.counts.GRIP || 0;
        setBanner("SURFACE TEXTURE MAP", "RELATIVE TO SCENE");

        frameCount++;
        const now = performance.now();
        if (now - fpsLast >= 1000) {
          fpsChip.textContent = `${frameCount} FPS`;
          frameCount = 0;
          fpsLast = now;
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
  if (video.requestVideoFrameCallback) {
    rvfcHandle = video.requestVideoFrameCallback(async () => {
      await processFrame();
      scheduleFrame();
    });
  } else {
    requestAnimationFrame(async () => {
      await processFrame();
      if (running) scheduleFrame();
    });
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
      slopeDeg = d.slopeDeg; // null in EST
      depthId = depthProvider.id;
      depthMode = depthId === "XR" ? "fused" : depthId === "AI" ? "ai" : "est";
      // Only real factors — null → pessimistic inside slopeConfidence
      slopeConf = slopeConfidence({
        mode: depthMode,
        inlier: d.inlierRatio,           // undefined unless fused
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
    const bitmap = await createImageBitmap(video);
    worker.postMessage({
      type: "frame",
      bitmap,
      slopeDeg,
      slopeConf,
      depthId,
      depthMode,
      cols,
      rows
    }, [bitmap]);
  } catch (e) {
    sending = false;
    console.error(e);
  }
}

function renderLoop() {
  canvas.style.transform = mirrorOverlay ? "scaleX(-1)" : "none";
  if (fontsReady) {
    drawHUD(ctx, lastTracks, lastMeta, layers, cssW, cssH, mirrorOverlay, performance.now());
  }
  requestAnimationFrame(renderLoop);
}

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
    // iOS: request sensor permission first, still inside user gesture
    const orientPerm = orient.start();
    await ensureFonts();
    const orientOk = await orientPerm;
    if (!orientOk) {
      // soft notice — analysis still runs without IMU
      console.warn("Motion/orientation permission denied");
    }
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
    setBanner("ANALYSING TERRAIN", "SCANNING SURFACE");
    if (depthChip) depthChip.textContent = `DEPTH:${depthProvider.id}`;
    worker.postMessage({ type: "reset" });
    cancelRvfc();
    scheduleFrame();
    await acquireWakeLock();
  } catch (e) {
    console.error(e);
    const msg = String(e);
    if (msg.includes("NotAllowed") || msg.includes("Permission") || msg.includes("denied")) {
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
    worker?.postMessage({ type: "reset" });
  } catch (e) {
    console.error(e);
    stop();
    setState("lost");
  }
});

allowBtn?.addEventListener("click", () => start());
retryBtn?.addEventListener("click", () => start());

sheet.querySelector(".grab").addEventListener("click", () => {
  sheet.dataset.open = sheet.dataset.open === "true" ? "false" : "true";
});

layersBtn.addEventListener("click", () => {
  layersPop.hidden = !layersPop.hidden;
});

layersPop.querySelectorAll("input[type=checkbox]").forEach(inp => {
  inp.checked = layers[inp.name] !== false;
  inp.addEventListener("change", () => {
    layers[inp.name] = inp.checked;
    localStorage.setItem("tv_layers", JSON.stringify(layers));
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
resizeCanvas();
ensureFonts().then(() => { fontsReady = true; });
renderLoop();
