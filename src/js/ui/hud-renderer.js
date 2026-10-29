import { formatSlope } from "../depth/fusion.js";

const COL = {
  GRIP:   "#3dff6a",
  CHECK:  "#38b6ff",
  REJECT: "#ff2d3a"
};

const PAL = [
  [255, 45, 58, 70],
  [56, 182, 255, 26],
  [61, 255, 106, 70]
];

let mosaic = null;
let mctx = null;
let lastCls = null;

export function coverTransform(canvasCssW, canvasCssH, srcW, srcH) {
  const s = Math.max(canvasCssW / srcW, canvasCssH / srcH);
  const ox = (canvasCssW - srcW * s) / 2;
  const oy = (canvasCssH - srcH * s) / 2;
  return { s, ox, oy, srcW, srcH };
}

function pathPartial(ctx, contour, age, cellToPx) {
  if (!contour || contour.length < 4) return;
  const n = Math.max(2, Math.floor((contour.length / 2) * age));
  const { ox, oy, s, srcW, srcH, bw, bh } = cellToPx;
  const sx = (srcW / bw) * s;
  const sy = (srcH / bh) * s;
  ctx.beginPath();
  ctx.moveTo(ox + contour[0] * sx, oy + contour[1] * sy);
  for (let i = 1; i < n; i++) {
    ctx.lineTo(ox + contour[i * 2] * sx, oy + contour[i * 2 + 1] * sy);
  }
  if (age >= 0.99) ctx.closePath();
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawLabelBox(ctx, box, line1, line2, color) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.fillStyle = "rgba(8,16,24,0.82)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, box.x, box.y, box.w, box.h, 4);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = "700 11px 'Share Tech Mono', monospace";
  ctx.fillText(line1, box.x + 6, box.y + 13);
  ctx.fillStyle = "#cfeaff";
  ctx.font = "10px 'Share Tech Mono', monospace";
  ctx.fillText(line2, box.x + 6, box.y + 26);
  ctx.restore();
}

function leaderLine(ctx, box, x, y, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  const lx = box.x + box.w / 2;
  const ly = box.y + box.h;
  ctx.moveTo(lx, ly);
  ctx.lineTo(lx, y);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

function ensureMosaic(bw, bh) {
  if (!mosaic) {
    mosaic = typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(bw, bh)
      : document.createElement("canvas");
    mctx = mosaic.getContext("2d");
  }
  if (mosaic.width !== bw || mosaic.height !== bh) {
    mosaic.width = bw;
    mosaic.height = bh;
    lastCls = null;
  }
}

function drawMosaic(ctx, cls, bw, bh, ct, sx, sy, canvasCssW, canvasCssH, t) {
  if (!cls || !bw || !bh) return;
  ensureMosaic(bw, bh);

  // Rebuild ImageData only when cls buffer identity changes (~analysis rate)
  if (cls !== lastCls) {
    const img = mctx.createImageData(bw, bh);
    const d = img.data;
    for (let i = 0; i < cls.length; i++) {
      const p = PAL[cls[i]] || PAL[1];
      const o = i * 4;
      d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = p[3];
    }
    mctx.putImageData(img, 0, 0);
    lastCls = cls;
  }

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = "high"; } catch (_) {}
  ctx.drawImage(mosaic, ct.ox, ct.oy, bw * sx, bh * sy);

  const y = ((t % 2200) / 2200) * canvasCssH;
  const g = ctx.createLinearGradient(0, y - 40, 0, y);
  g.addColorStop(0, "rgba(56,182,255,0)");
  g.addColorStop(1, "rgba(56,182,255,0.35)");
  ctx.fillStyle = g;
  ctx.fillRect(0, y - 40, canvasCssW, 40);
  ctx.restore();
}

export function drawHUD(ctx, tracks, meta, layers, canvasCssW, canvasCssH, mirror, now = performance.now()) {
  ctx.clearRect(0, 0, canvasCssW, canvasCssH);

  const { bw, bh, vw, vh, w, h, cls } = meta;
  if (!bw || !bh) return;

  const srcW = vw || w || 320;
  const srcH = vh || h || 180;
  const ct = coverTransform(canvasCssW, canvasCssH, srcW, srcH);
  const cellToPx = { ...ct, bw, bh };
  const sx = (srcW / bw) * ct.s;
  const sy = (srcH / bh) * ct.s;

  if (layers.mosaic !== false && cls) {
    drawMosaic(ctx, cls, bw, bh, ct, sx, sy, canvasCssW, canvasCssH, now);
  }

  // Worker already marked show + smoothed contour
  const top = tracks.filter(t => t.show && (layers.reject !== false || t.cls !== "REJECT"));
  const placed = [];

  for (const k of top) {
    const c = COL[k.cls] || COL.CHECK;
    const age = Math.min(1, k.age / 10);

    if (layers.contour !== false && k.contour) {
      ctx.save();
      ctx.strokeStyle = c;
      ctx.lineWidth = 2;
      ctx.shadowColor = c;
      ctx.shadowBlur = 6;
      ctx.fillStyle = c + "28";
      pathPartial(ctx, k.contour, age, cellToPx);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    if (layers.labels !== false) {
      const cx = ct.ox + k.cx * sx;
      const cy = ct.oy + k.cy * sy;
      const by = ct.oy + k.miny * sy;

      let box = { x: cx - 48, y: by - 40, w: 100, h: 32 };
      for (let i = 0; i < 8 && placed.some(p =>
        !(box.x + box.w < p.x || p.x + p.w < box.x || box.y + box.h < p.y || p.y + p.h < box.y)
      ); i++) box.y -= 36;
      box.x = Math.max(4, Math.min(canvasCssW - box.w - 4, box.x));
      box.y = Math.max(4, Math.min(canvasCssH - box.h - 4, box.y));
      placed.push(box);

      ctx.save();
      if (mirror) {
        ctx.translate(box.x + box.w / 2, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(box.x + box.w / 2), 0);
      }
      const pct = Math.round((k.conf ?? k.score) * 100);
      let confLabel = `SCORE ${pct}`;
      const slopeFmt = formatSlope(k.slopeDeg, k.slopeConf ?? 0, k.depthMode || "est");
      if (slopeFmt) confLabel += ` ${slopeFmt.text}`;
      drawLabelBox(ctx, box, `L${k.id} ${k.tag || "SMOOTH"}`, confLabel, c);
      ctx.restore();

      if (layers.leader !== false) {
        leaderLine(ctx, box, cx, cy, c);
      }
    }
  }
}

export { COL };
