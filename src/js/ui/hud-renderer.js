import { formatSlope } from "../depth/fusion.js";

const COL = {
  GRIP:   "#3dff6a",
  CHECK:  "#38b6ff",
  REJECT: "#ff2d3a"
};

export function coverTransform(canvasCssW, canvasCssH, srcW, srcH) {
  const s = Math.max(canvasCssW / srcW, canvasCssH / srcH);
  const ox = (canvasCssW - srcW * s) / 2;
  const oy = (canvasCssH - srcH * s) / 2;
  return { s, ox, oy, srcW, srcH };
}

function smoothPath(ctx, contour, cellToPx) {
  if (!contour || contour.length < 6) return;
  const { ox, oy, s, srcW, srcH, bw, bh } = cellToPx;
  const sx = (srcW / bw) * s;
  const sy = (srcH / bh) * s;
  const px = (i) => ox + contour[i] * sx;
  const py = (i) => oy + contour[i + 1] * sy;
  const n = contour.length;
  ctx.beginPath();
  ctx.moveTo((px(0) + px(2)) / 2, (py(0) + py(2)) / 2);
  for (let i = 2; i < n - 2; i += 2) {
    ctx.quadraticCurveTo(px(i), py(i), (px(i) + px(i + 2)) / 2, (py(i) + py(i + 2)) / 2);
  }
  ctx.closePath();
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
  ctx.fillStyle = "rgba(8,16,24,0.82)";
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, box.x, box.y, box.w, box.h, 4);
  ctx.fill();
  ctx.stroke();
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

/** Overlay only — mosaic is a separate DOM canvas */
export function drawHUD(ctx, tracks, meta, layers, canvasCssW, canvasCssH, mirror) {
  ctx.clearRect(0, 0, canvasCssW, canvasCssH);

  const { bw, bh, vw, vh, w, h } = meta;
  if (!bw || !bh) return;

  const srcW = vw || w || 320;
  const srcH = vh || h || 180;
  const ct = coverTransform(canvasCssW, canvasCssH, srcW, srcH);
  const cellToPx = { ...ct, bw, bh };
  const sx = (srcW / bw) * ct.s;
  const sy = (srcH / bh) * ct.s;

  // Worker already sent only chosen tracks
  const top = tracks.filter(t => layers.reject !== false || t.cls !== "REJECT");
  const placed = [];

  for (const k of top) {
    const c = COL[k.cls] || COL.CHECK;

    if (layers.contour !== false && k.contour && k.contour.length >= 6) {
      ctx.save();
      smoothPath(ctx, k.contour, cellToPx);
      ctx.strokeStyle = c;
      ctx.lineWidth = 5;
      ctx.globalAlpha = 0.25;
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.globalAlpha = 1;
      ctx.stroke();
      ctx.fillStyle = c + "28";
      ctx.fill();
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
