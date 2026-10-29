import { classify, verbFor, tagFor } from "./scorer.js";

function iou(a, b) {
  const ax1 = a.minx, ay1 = a.miny, ax2 = a.maxx, ay2 = a.maxy;
  const bx1 = b.minx, by1 = b.miny, bx2 = b.maxx, by2 = b.maxy;
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const areaA = Math.max(1, (ax2 - ax1) * (ay2 - ay1));
  const areaB = Math.max(1, (bx2 - bx1) * (by2 - by1));
  return inter / (areaA + areaB - inter + 1e-6);
}

export class Tracker {
  constructor() {
    this.tracks = [];
    this.nextId = 1;
  }

  update(dets) {
    const matchedT = new Set();
    const matchedD = new Set();
    const pairs = [];

    for (let ti = 0; ti < this.tracks.length; ti++) {
      for (let di = 0; di < dets.length; di++) {
        const t = this.tracks[ti], d = dets[di];
        if (!!t.forceReject !== !!d.forceReject) continue;
        const dx = t.cx - d.cx, dy = t.cy - d.cy;
        if (dx * dx + dy * dy > 64) continue;
        const ov = iou(t, d);
        const dist = Math.hypot(dx, dy);
        const score = ov * 2 - dist * 0.05;
        if (ov > 0.1 || dist < 6) pairs.push({ ti, di, score });
      }
    }
    pairs.sort((a, b) => b.score - a.score);

    for (const p of pairs) {
      if (matchedT.has(p.ti) || matchedD.has(p.di)) continue;
      matchedT.add(p.ti);
      matchedD.add(p.di);
      const t = this.tracks[p.ti];
      const d = dets[p.di];
      const a = 0.4;
      t.score = a * d.score + (1 - a) * t.score;
      t.cx = a * d.cx + (1 - a) * t.cx;
      t.cy = a * d.cy + (1 - a) * t.cy;
      t.minx = d.minx; t.miny = d.miny; t.maxx = d.maxx; t.maxy = d.maxy;
      t.area = d.area;
      t.flatness = d.flatness;
      t.curId = d.id; // patch id valid only this frame (for delayed trace)
      t.forceReject = !!d.forceReject;
      t.hits++;
      t.miss = 0;
      t.age++;
      t.cls = classify(t.score, t.cls, t.forceReject);
      if (t.forceReject || t.cls === "REJECT") {
        t.conf = a * (1 - (t.flatness ?? 0)) + (1 - a) * (t.conf ?? (1 - (t.flatness ?? 0)));
      } else {
        t.conf = a * t.score + (1 - a) * (t.conf || t.score);
      }
      t.verb = verbFor(t.cls);
      t.tag = tagFor(t.cls);
    }

    for (let di = 0; di < dets.length; di++) {
      if (matchedD.has(di)) continue;
      const d = dets[di];
      const forceReject = !!d.forceReject;
      const cls = classify(d.score, null, forceReject);
      const conf = forceReject || cls === "REJECT" ? (1 - (d.flatness ?? 0)) : d.score;
      this.tracks.push({
        ...d,
        id: this.nextId++,
        curId: d.id,
        forceReject,
        cls,
        conf,
        verb: verbFor(cls),
        tag: tagFor(cls),
        hits: 1,
        miss: 0,
        age: 1
      });
    }

    for (let ti = 0; ti < this.tracks.length; ti++) {
      if (matchedT.has(ti)) continue;
      this.tracks[ti].miss++;
      this.tracks[ti].age++;
    }

    this.tracks = this.tracks.filter(t => t.miss <= 3);
    return this.tracks.filter(t => t.hits >= 3 && t.miss === 0);
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }
}
