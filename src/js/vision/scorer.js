const T = { grip: 0.70, check: 0.45, hyst: 0.05 };
const AREA_REF = 40;

/**
 * Texture-based score. EST slope never affects class.
 * Slope term only when depthMode is fused/ai with real confidence.
 * Bobot tanpa slope: flatness 0.6875, size 0.3125 (setara perilaku sebelumnya).
 */
export function scorePatch(p) {
  const flat = p.flatness ?? 0.5;
  const sizeTerm = Math.min(1, (p.area || 0) / AREA_REF);

  const mode = p.depthMode || "est";
  let slopeConf = Math.max(0, Math.min(1, p.slopeConf ?? 0));
  if (mode === "est") slopeConf = 0;

  let slopeNorm = 0.3;
  if (p.slopeDeg != null && Number.isFinite(p.slopeDeg)) {
    slopeNorm = Math.min(1, Math.max(0, p.slopeDeg / 40));
  }
  const wSlope = 0.20 * slopeConf;
  const rest = 1 - wSlope;
  const wFlat = rest * 0.6875;
  const wSize = rest * 0.3125;

  const s = wFlat * flat + wSize * sizeTerm + wSlope * (1 - slopeNorm);

  return {
    score: Math.max(0, Math.min(1, s)),
    slopeDeg: mode === "est" ? null : (p.slopeDeg ?? null),
    slopeConf,
    depthMode: mode
  };
}

export function classify(score, prev, forceReject = false) {
  if (forceReject) return "REJECT";
  if (score > T.grip  + (prev === "GRIP"  ? -T.hyst : 0)) return "GRIP";
  if (score > T.check + (prev === "CHECK" ? -T.hyst : 0)) return "CHECK";
  return "REJECT";
}

/** Texture vocabulary until real slope exists */
export function tagFor(c) {
  if (c === "GRIP") return "SMOOTH";
  if (c === "CHECK") return "MIXED";
  return "ROUGH";
}

export function verbFor(c) {
  return "TEXTURE";
}
