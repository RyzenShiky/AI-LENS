/**
 * Depth fusion & confidence — honest metrics for slope display.
 * Modes: fused (XR+AI), ai, est
 */

const STEP = 8;

export function ransacLine(samples, { iters = 64, tol = 0.15 } = {}) {
  if (samples.length < 8) {
    return { a: 1, b: 0, inlierRatio: 0, rmse: 999 };
  }
  let best = { a: 1, b: 0, inliers: 0, rmse: 999 };
  const n = samples.length;

  for (let t = 0; t < iters; t++) {
    const i = (Math.random() * n) | 0;
    const j = (Math.random() * n) | 0;
    if (i === j) continue;
    const [x0, y0] = samples[i];
    const [x1, y1] = samples[j];
    const dx = x1 - x0;
    if (Math.abs(dx) < 1e-6) continue;
    const a = (y1 - y0) / dx;
    const b = y0 - a * x0;

    let inliers = 0, sse = 0;
    for (let k = 0; k < n; k++) {
      const [x, y] = samples[k];
      const e = Math.abs(a * x + b - y);
      if (e < tol) {
        inliers++;
        sse += e * e;
      }
    }
    if (inliers > best.inliers) {
      best = { a, b, inliers, rmse: inliers ? Math.sqrt(sse / inliers) : 999 };
    }
  }

  return {
    a: best.a,
    b: best.b,
    inlierRatio: best.inliers / n,
    rmse: best.rmse
  };
}

export function alignAI(ai, xr, xrConf) {
  const S = [];
  const len = Math.min(ai.length, xr.length);
  for (let i = 0; i < len; i += STEP) {
    const conf = xrConf ? xrConf[i] : 1;
    if (xr[i] > 0.2 && xr[i] < 8 && conf > 0.5 && ai[i] > 0) {
      S.push([ai[i], xr[i]]);
    }
  }

  const fit = ransacLine(S);
  if (fit.inlierRatio < 0.5 || fit.rmse > 0.4) {
    return { fused: null, fit, mode: "ai" };
  }

  const fused = new Float32Array(ai.length);
  for (let i = 0; i < ai.length; i++) {
    fused[i] = fit.a * ai[i] + fit.b;
  }
  return { fused, fit, mode: "fused" };
}

export class ScaleSmoother {
  constructor(alpha = 0.15) {
    this.a = 1;
    this.b = 0;
    this.alpha = alpha;
    this.init = false;
  }
  update(a, b) {
    if (!this.init) {
      this.a = a; this.b = b; this.init = true;
      return { a, b };
    }
    this.a = this.alpha * a + (1 - this.alpha) * this.a;
    this.b = this.alpha * b + (1 - this.alpha) * this.b;
    return { a: this.a, b: this.b };
  }
  reset() { this.init = false; this.a = 1; this.b = 0; }
}

/**
 * Honest confidence — MIN of factors.
 * Missing data must be pessimistic (not treated as perfect via || 1).
 */
export function slopeConfidence(ctx) {
  const src = { fused: 1.0, ai: 0.6, est: 0.2 }[ctx.mode] ?? 0.15;
  const fit = ctx.mode === "fused"
    ? Math.min(1, (ctx.inlier ?? 0) / 0.8)
    : 1;

  // No measurement → pessimistic defaults
  const gyroMag = ctx.gyroMag;
  const stable = gyroMag == null
    ? 0.5
    : 1 - Math.min(1, gyroMag / 1.5);

  const points = ctx.points;
  const pts = points == null
    ? 0.3   // unknown → mildly pessimistic
    : points <= 0
      ? 0   // known empty → zero trust
      : Math.min(1, points / 150);

  const normalStd = ctx.normalStd;
  const spread = normalStd == null
    ? 0.4
    : 1 - Math.min(1, normalStd / 15);

  return src * Math.min(fit, stable, pts, spread);
}

export function slopeTier(conf) {
  if (conf >= 0.65) return "high";
  if (conf >= 0.35) return "medium";
  return "low";
}

/**
 * Only show slope numbers after real depth (fused/ai) + medium+ confidence.
 * No fabricated ± until calibration exists — medium shows coarse band only.
 */
export function formatSlope(deg, conf, mode) {
  if (mode === "est") return null;
  if (deg == null || !Number.isFinite(deg)) return null;
  const tier = slopeTier(conf);
  if (tier === "low") return null;
  if (tier === "medium") {
    const lo = Math.max(0, Math.round(deg / 5) * 5 - 5);
    const hi = lo + 10;
    return { tier, text: `${lo}–${hi}°`, deg };
  }
  // high: still no fake ± until ramp calibration — show rounded degree only
  return { tier, text: `~${Math.round(deg)}°`, deg };
}

export function depthBadge(mode) {
  if (mode === "fused") return "DEPTH XR+AI";
  if (mode === "ai") return "DEPTH AI";
  return "DEPTH EST";
}
