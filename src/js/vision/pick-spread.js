/** One best track per screen grid cell */
export function pickSpread(tracks, bw, bh, cols, rows) {
  const best = new Map();
  for (const t of tracks) {
    const col = Math.min(cols - 1, Math.max(0, ((t.cx / bw) * cols) | 0));
    const row = Math.min(rows - 1, Math.max(0, ((t.cy / bh) * rows) | 0));
    const key = row * cols + col;
    const cur = best.get(key);
    if (!cur || t.score > cur.score) best.set(key, t);
  }
  return [...best.values()];
}
