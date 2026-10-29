import { Tracker } from "./tracker.js";
import { scorePatch } from "./scorer.js";
import { pickSpread } from "./pick-spread.js";

let M = null;
let tracker = new Tracker();
let off = null;
let busy = false;

let ptrRGBA = 0, ptrMap = 0, ptrMapInv = 0, ptrIds = 0, ptrContour = 0, ptrPatches = 0;
let capRGBA = 0;

const BLOCK = 8;
const MAX_CONTOUR = 512;
const PATCH_STRIDE = 48;

/** EMA state for relative thresholds — reduces flicker */
const emaState = { hi: null, lo: null };
function ema(key, value, alpha = 0.25) {
  if (emaState[key] == null) emaState[key] = value;
  else emaState[key] = alpha * value + (1 - alpha) * emaState[key];
  return emaState[key];
}

function simdSupported() {
  try {
    return WebAssembly.validate(new Uint8Array([
      0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
    ]));
  } catch (_) { return false; }
}

function ensureBuf(w, h) {
  const need = w * h * 4;
  if (need <= capRGBA && ptrRGBA) return;
  if (ptrRGBA) { M._free(ptrRGBA); ptrRGBA = 0; }
  if (ptrMap) { M._free(ptrMap); ptrMap = 0; }
  if (ptrMapInv) { M._free(ptrMapInv); ptrMapInv = 0; }
  if (ptrIds) { M._free(ptrIds); ptrIds = 0; }
  if (ptrContour) { M._free(ptrContour); ptrContour = 0; }
  if (ptrPatches) { M._free(ptrPatches); ptrPatches = 0; }

  ptrRGBA = M._malloc(need);
  const bw = Math.floor(w / BLOCK), bh = Math.floor(h / BLOCK);
  ptrMap = M._malloc(bw * bh);
  ptrMapInv = M._malloc(bw * bh);
  ptrIds = M._malloc(bw * bh * 2);
  ptrContour = M._malloc(MAX_CONTOUR * 4);
  ptrPatches = M._malloc(64 * PATCH_STRIDE);
  capRGBA = need;
}

function readPatches(count) {
  const view = new DataView(M.HEAPU8.buffer, ptrPatches, count * PATCH_STRIDE);
  const out = [];
  for (let i = 0; i < count; i++) {
    const o = i * PATCH_STRIDE;
    const id = view.getInt32(o, true);
    const minx = view.getInt32(o + 4, true);
    const miny = view.getInt32(o + 8, true);
    const maxx = view.getInt32(o + 12, true);
    const maxy = view.getInt32(o + 16, true);
    const area = view.getInt32(o + 20, true);
    const flatness = view.getFloat32(o + 24, true);
    const cx = view.getFloat32(o + 28, true);
    const cy = view.getFloat32(o + 32, true);
    if (area <= 0) continue;
    out.push({ id, minx, miny, maxx, maxy, area, flatness, cx, cy });
  }
  return out;
}

function chaikin(pts, iters) {
  if (!pts || pts.length < 6) return pts;
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const n = (cur.length / 2) | 0;
    const closed = Math.hypot(cur[0] - cur[cur.length - 2], cur[1] - cur[cur.length - 1]) < 1.5;
    const limit = closed ? n - 1 : n - 1;
    const next = new Float32Array(limit * 4 + (closed ? 2 : 0));
    let w = 0;
    for (let i = 0; i < limit; i++) {
      const j = (i + 1) % n;
      const x0 = cur[i * 2], y0 = cur[i * 2 + 1];
      const x1 = cur[j * 2], y1 = cur[j * 2 + 1];
      next[w++] = 0.75 * x0 + 0.25 * x1;
      next[w++] = 0.75 * y0 + 0.25 * y1;
      next[w++] = 0.25 * x0 + 0.75 * x1;
      next[w++] = 0.25 * y0 + 0.75 * y1;
    }
    if (closed && w >= 4) {
      next[w++] = next[0];
      next[w++] = next[1];
    }
    cur = next.subarray(0, w);
  }
  return Array.from(cur);
}

function readContourRaw(nPts) {
  if (nPts < 2) return null;
  const view = new Int16Array(M.HEAPU8.buffer, ptrContour, nPts * 2);
  const raw = new Float32Array(nPts * 2);
  for (let i = 0; i < nPts; i++) {
    raw[i * 2] = view[i * 2] + 0.5;
    raw[i * 2 + 1] = view[i * 2 + 1] + 0.5;
  }
  return raw;
}

function collectFromMap(mapPtr, thr, forceReject, bw, bh, slopeInfo) {
  const nPatches = M._label_patches(mapPtr, bw, bh, thr, ptrIds);
  if (nPatches <= 0) return [];
  const nExtract = M._extract_patches(mapPtr, ptrIds, bw, bh, nPatches, ptrPatches);
  let patches = readPatches(nExtract);

  return patches.map(p => {
    const n = M._trace_contour(ptrIds, bw, bh, p.id, ptrContour, MAX_CONTOUR);
    const contourRaw = readContourRaw(n);
    let flat = p.flatness;
    if (forceReject) flat = 1 - flat;

    let slopeDeg = slopeInfo?.slopeDeg ?? null;
    let slopeConf = slopeInfo?.slopeConf ?? 0;
    if (slopeDeg != null) {
      const yNorm = p.cy / Math.max(1, bh);
      slopeDeg = slopeDeg * (0.85 + 0.3 * yNorm);
      slopeConf = slopeConf * (0.7 + 0.3 * (1 - Math.abs(yNorm - 0.6)));
    }

    const scored = scorePatch({
      ...p,
      flatness: flat,
      roughness: 1 - flat,
      slopeDeg,
      slopeConf,
      depthMode: slopeInfo.depthMode,
      _bh: bh
    });
    return { ...p, flatness: flat, ...scored, contourRaw, forceReject };
  });
}

function applyShowAndSmooth(tracked, bw, bh, cols, rows) {
  const chosen = new Set(pickSpread(tracked, bw, bh, cols, rows));
  for (const t of tracked) {
    t.show = chosen.has(t);
    t.contour = t.show && t.contourRaw ? chaikin(t.contourRaw, 2) : null;
    delete t.contourRaw;
  }
  return tracked;
}

self.onmessage = async (ev) => {
  const data = ev.data;

  if (data.type === "init") {
    try {
      let usedSimd = false;
      let createModuleFn;
      if (simdSupported()) {
        try {
          createModuleFn = (await import("../../../build/terrain.simd.mjs")).default;
          usedSimd = true;
        } catch (_) {
          createModuleFn = (await import("../../../build/terrain.mjs")).default;
        }
      } else {
        createModuleFn = (await import("../../../build/terrain.mjs")).default;
      }
      M = await createModuleFn();
      off = new OffscreenCanvas(320, 180);
      tracker.reset();
      emaState.hi = null;
      emaState.lo = null;
      self.postMessage({ type: "ready", simdLoaded: usedSimd });
    } catch (e) {
      self.postMessage({ type: "error", message: String(e) });
    }
    return;
  }

  if (data.type === "reset") {
    tracker.reset();
    emaState.hi = null;
    emaState.lo = null;
    return;
  }

  if (data.type === "frame") {
    if (!M || busy) {
      data.bitmap?.close?.();
      return;
    }
    busy = true;
    const t0 = performance.now();
    const slopeInfo = {
      slopeDeg: data.slopeDeg ?? null,
      slopeConf: data.slopeConf ?? 0,
      depthId: data.depthId || "EST",
      depthMode: data.depthMode || "est"
    };

    try {
      const bitmap = data.bitmap;
      const vw = bitmap.width;
      const vh = bitmap.height;
      const targetW = 320;
      const targetH = Math.max(BLOCK * 2, Math.round(targetW * vh / vw));
      const w = targetW - (targetW % BLOCK);
      const h = targetH - (targetH % BLOCK);

      off.width = w;
      off.height = h;
      const g = off.getContext("2d", { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0, w, h);
      bitmap.close?.();

      const img = g.getImageData(0, 0, w, h);
      ensureBuf(w, h);
M.HEAPU8.set(img.data, ptrRGBA);

      const bw = w / BLOCK, bh = h / BLOCK;
      M._feasibility_map(ptrRGBA, w, h, ptrMap);

      const mapBytes = bw * bh;
      const mapView = M.HEAPU8.subarray(ptrMap, ptrMap + mapBytes);
      const invView = M.HEAPU8.subarray(ptrMapInv, ptrMapInv + mapBytes);
      for (let i = 0; i < mapBytes; i++) invView[i] = 255 - mapView[i];

      // Relative thresholds (percentiles) + EMA anti-flicker
      // Floor: optional absolute minimum so pure noise doesn't invent "smooth"
      const ABS_FLOOR = 40;
      const sorted = Uint8Array.from(mapView);
      sorted.sort();
      const rawHi = sorted[(sorted.length * 0.67) | 0];
      const rawLo = sorted[(sorted.length * 0.33) | 0];
      const tHi = Math.max(ABS_FLOOR, ema("hi", rawHi) | 0);
      const tLo = Math.min(tHi - 1, ema("lo", rawLo) | 0);

      // Per-cell class map: 0=rough, 1=mixed, 2=smooth (relative to this scene)
      const cls = new Uint8Array(mapBytes);
      for (let i = 0; i < mapBytes; i++) {
        const v = mapView[i];
        cls[i] = v >= tHi ? 2 : v <= tLo ? 0 : 1;
      }

      const good = collectFromMap(ptrMap, tHi, false, bw, bh, slopeInfo);
      const bad  = collectFromMap(ptrMapInv, 255 - tLo, true, bw, bh, slopeInfo);
      // Soft cap: allow larger rough patches (was 40%)
      const cellLimit = bw * bh * 0.55;
      const badFiltered = bad.filter(p => p.area <= cellLimit);

      const cols = data.cols || 3;
      const rows = data.rows || 4;
      let tracked = tracker.update([...good, ...badFiltered]);
      tracked = applyShowAndSmooth(tracked, bw, bh, cols, rows);
      const ms = performance.now() - t0;

      const counts = { GRIP: 0, CHECK: 0, REJECT: 0 };
      for (const t of tracked) counts[t.cls] = (counts[t.cls] || 0) + 1;

      self.postMessage({
        type: "result",
        tracked,
        counts,
        ms,
        w, h, bw, bh, vw, vh,
        depthId: slopeInfo.depthId,
        depthMode: slopeInfo.depthMode,
        slopeDeg: slopeInfo.slopeDeg,
        slopeConf: slopeInfo.slopeConf,
        tHi, tLo,
        cls
      }, [cls.buffer]);
    } catch (e) {
      self.postMessage({ type: "error", message: String(e) });
    } finally {
      busy = false;
    }
  }
};
