import { Tracker } from "./tracker.js";
import { scorePatch } from "./scorer.js";
import { pickSpread } from "./pick-spread.js";

let M = null;
let tracker = new Tracker();
let off = null;
let busy = false;

let ptrRGBA = 0, ptrMap = 0, ptrMapInv = 0;
let ptrIdsG = 0, ptrIdsB = 0, ptrContour = 0, ptrPatches = 0;
let capRGBA = 0;

const BLOCK = 8;
const MAX_CONTOUR = 512;
const PATCH_STRIDE = 48;
const hist = new Uint32Array(256);

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
  if (ptrIdsG) { M._free(ptrIdsG); ptrIdsG = 0; }
  if (ptrIdsB) { M._free(ptrIdsB); ptrIdsB = 0; }
  if (ptrContour) { M._free(ptrContour); ptrContour = 0; }
  if (ptrPatches) { M._free(ptrPatches); ptrPatches = 0; }

  ptrRGBA = M._malloc(need);
  const bw = Math.floor(w / BLOCK), bh = Math.floor(h / BLOCK);
  ptrMap = M._malloc(bw * bh);
  ptrMapInv = M._malloc(bw * bh);
  ptrIdsG = M._malloc(bw * bh * 2);
  ptrIdsB = M._malloc(bw * bh * 2);
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
    if (area < 6) continue;
    out.push({ id, minx, miny, maxx, maxy, area, flatness, cx, cy });
  }
  return out;
}

/** Drop colinear points; return Float32Array of cell-center coords */
function decimate(p) {
  const n = p.length / 2;
  if (n < 2) return null;
  const out = [p[0] + 0.5, p[1] + 0.5];
  for (let i = 1; i < n - 1; i++) {
    const cross =
      (p[i * 2] - p[i * 2 - 2]) * (p[i * 2 + 3] - p[i * 2 + 1]) -
      (p[i * 2 + 1] - p[i * 2 - 1]) * (p[i * 2 + 2] - p[i * 2]);
    if (cross !== 0) out.push(p[i * 2] + 0.5, p[i * 2 + 1] + 0.5);
  }
  out.push(p[n * 2 - 2] + 0.5, p[n * 2 - 1] + 0.5);
  return Float32Array.from(out);
}

function collectFromMap(mapPtr, idsPtr, thr, forceReject, bw, bh, slopeInfo) {
  const n = M._label_patches(mapPtr, bw, bh, thr, idsPtr);
  if (n <= 0) return [];
  const k = M._extract_patches(mapPtr, idsPtr, bw, bh, n, ptrPatches);
  return readPatches(k).map(p => {
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
      ...p, flatness: flat, roughness: 1 - flat,
      slopeDeg, slopeConf, depthMode: slopeInfo.depthMode, _bh: bh
    });
    return { ...p, flatness: flat, ...scored, forceReject };
  });
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
      const longSide = data.longSide || 320;
      const scale = longSide / Math.max(vw, vh);
      let w = Math.max(16, Math.round(vw * scale / BLOCK) * BLOCK);
      let h = Math.max(16, Math.round(vh * scale / BLOCK) * BLOCK);
      if (w > 640 || h > 640) {
        const s2 = 640 / Math.max(w, h);
        w = Math.max(16, Math.round(w * s2 / BLOCK) * BLOCK);
        h = Math.max(16, Math.round(h * s2 / BLOCK) * BLOCK);
      }

      if (off.width !== w) off.width = w;
      if (off.height !== h) off.height = h;
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

      // Histogram percentiles + inverse in one pass
      hist.fill(0);
      for (let i = 0; i < mapBytes; i++) {
        const v = mapView[i];
        hist[v]++;
        invView[i] = 255 - v;
      }
      let acc = 0, rawLo = 0, rawHi = 255, gotLo = false;
      const n33 = mapBytes * 0.33, n67 = mapBytes * 0.67;
      for (let v = 0; v < 256; v++) {
        acc += hist[v];
        if (!gotLo && acc >= n33) { rawLo = v; gotLo = true; }
        if (acc >= n67) { rawHi = v; break; }
      }
      const ABS_FLOOR = 40;
      const tHi = Math.max(ABS_FLOOR, ema("hi", rawHi) | 0);
      const tLo = Math.min(tHi - 1, ema("lo", rawLo) | 0);

      const cls = new Uint8Array(mapBytes);
      for (let i = 0; i < mapBytes; i++) {
        const v = mapView[i];
        cls[i] = v >= tHi ? 2 : v <= tLo ? 0 : 1;
      }

      const good = collectFromMap(ptrMap, ptrIdsG, tHi, false, bw, bh, slopeInfo);
      const bad  = collectFromMap(ptrMapInv, ptrIdsB, 255 - tLo, true, bw, bh, slopeInfo);
      const cellLimit = bw * bh * 0.55;
      const badFiltered = bad.filter(p => p.area <= cellLimit);

      const tracked = tracker.update([...good, ...badFiltered]);
      const cols = data.cols || 3;
      const rows = data.rows || 4;
      const chosen = pickSpread(tracked, bw, bh, cols, rows);

      const transfer = [cls.buffer];
      for (const t of tracked) t.contour = null;
      for (const t of chosen) {
        const idsPtr = t.forceReject ? ptrIdsB : ptrIdsG;
        const n = M._trace_contour(idsPtr, bw, bh, t.curId, ptrContour, MAX_CONTOUR);
        if (n >= 3) {
          const raw = new Int16Array(M.HEAPU8.buffer, ptrContour, n * 2);
          // copy before next trace overwrites
          const copy = new Int16Array(n * 2);
          copy.set(raw);
          t.contour = decimate(copy);
          if (t.contour) transfer.push(t.contour.buffer);
        }
      }

      const counts = { GRIP: 0, CHECK: 0, REJECT: 0 };
      for (const t of tracked) counts[t.cls] = (counts[t.cls] || 0) + 1;
      const ms = performance.now() - t0;

      self.postMessage({
        type: "result",
        tracked: chosen,
        counts,
        ms,
        w, h, bw, bh, vw, vh,
        depthId: slopeInfo.depthId,
        depthMode: slopeInfo.depthMode,
        slopeDeg: slopeInfo.slopeDeg,
        slopeConf: slopeInfo.slopeConf,
        tHi, tLo,
        cls
      }, transfer);
    } catch (e) {
      self.postMessage({ type: "error", message: String(e) });
    } finally {
      busy = false;
    }
  }
};
