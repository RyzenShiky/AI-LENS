export const MODES = {
  performance: { longSide: 288, hz: 8,  contour: false, dpr: 1 },
  balanced:    { longSide: 384, hz: 12, contour: true,  dpr: 1.5 },
  quality:     { longSide: 512, hz: 20, contour: true,  dpr: 2 }
};
export const ORDER = ["performance", "balanced", "quality"];

export class AutoMode {
  constructor() {
    this.i = 1;
    this.bad = 0;
    this.good = 0;
    this.cooldownUntil = 0;
  }
  reset() {
    const weak =
      (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) ||
      (navigator.deviceMemory && navigator.deviceMemory <= 3);
    this.i = weak ? 0 : 1;
    this.bad = this.good = 0;
  }
  update({ workerMs, renderMs, achievedHz }) {
    if (performance.now() < this.cooldownUntil) return ORDER[this.i];
    const m = MODES[ORDER[this.i]];
    const budget = 1000 / m.hz;
    const load = (workerMs + renderMs) / budget;
    const behind = achievedHz < m.hz * 0.8;
    if (load > 0.8 || behind) { this.bad++; this.good = 0; }
    else if (load < 0.35) { this.good++; this.bad = 0; }
    else { this.bad = this.good = 0; }
    if (this.bad >= 20 && this.i > 0) {
      this.i--; this.bad = 0;
      this.cooldownUntil = performance.now() + 3000;
    }
    if (this.good >= 120 && this.i < 2) {
      this.i++; this.good = 0;
      this.cooldownUntil = performance.now() + 3000;
    }
    return ORDER[this.i];
  }
}
