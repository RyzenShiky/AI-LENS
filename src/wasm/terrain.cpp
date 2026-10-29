#include "terrain.h"
#include <cstring>
#include <cmath>
#include <algorithm>

// Static scratch — no per-frame heap alloc
static uint8_t  s_gray[TV_MAX_W * TV_MAX_H];
static uint16_t s_queue[TV_MAX_CELLS];
static uint8_t  s_visited[TV_MAX_CELLS];

static inline int clampi(int v, int lo, int hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

extern "C" {

void feasibility_map(const uint8_t* rgba, int w, int h, uint8_t* out) {
  if (!rgba || !out || w < TV_BLOCK || h < TV_BLOCK) return;
  if (w > TV_MAX_W || h > TV_MAX_H) return;

  const int size = w * h;
  for (int i = 0; i < size; i++) {
    const int p = i * 4;
    s_gray[i] = (uint8_t)((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8);
  }

  const int bw = w / TV_BLOCK;
  const int bh = h / TV_BLOCK;

  for (int by = 0; by < bh; by++) {
    for (int bx = 0; bx < bw; bx++) {
      int edgeSum = 0;
      int sum = 0, sum2 = 0, n = 0;

      const int x0 = bx * TV_BLOCK;
      const int y0 = by * TV_BLOCK;

      for (int y = y0; y < y0 + TV_BLOCK; y++) {
        for (int x = x0; x < x0 + TV_BLOCK; x++) {
          const int g = s_gray[y * w + x];
          sum  += g;
          sum2 += g * g;
          n++;
          if (x + 1 < w && y + 1 < h) {
            const int gx = (int)s_gray[y * w + (x + 1)] - g;
            const int gy = (int)s_gray[(y + 1) * w + x] - g;
            edgeSum += (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
          }
        }
      }

      float edgeDensity = (float)edgeSum / (float)(n * 120.0f + 1e-3f);
      if (edgeDensity > 1.f) edgeDensity = 1.f;

      float mean = (float)sum / (float)n;
      float var  = (float)sum2 / (float)n - mean * mean;
      if (var < 0) var = 0;
      float tex = var / (1600.f);
      if (tex > 1.f) tex = 1.f;

      float risk = 0.65f * edgeDensity + 0.35f * tex;
      int fea = (int)((1.f - risk) * 255.f);
      out[by * bw + bx] = (uint8_t)clampi(fea, 0, 255);
    }
  }
}

int label_patches(const uint8_t* map, int bw, int bh, uint8_t thr, uint16_t* ids) {
  if (!map || !ids || bw < 1 || bh < 1) return 0;
  const int cells = bw * bh;
  if (cells > TV_MAX_CELLS) return 0;

  std::memset(ids, 0, cells * sizeof(uint16_t));
  std::memset(s_visited, 0, cells);

  int patchCount = 0;
  const int MIN_AREA = 4;
  static const int dx[4] = {1, -1, 0, 0};
  static const int dy[4] = {0, 0, 1, -1};

  for (int i = 0; i < cells; i++) {
    if (s_visited[i] || map[i] < thr) continue;

    int qh = 0, qt = 0;
    s_queue[qt++] = (uint16_t)i;
    s_visited[i] = 1;
    int area = 0;

    while (qh < qt) {
      int cur = s_queue[qh++];
      area++;
      int cx = cur % bw, cy = cur / bw;
      for (int k = 0; k < 4; k++) {
        int nx = cx + dx[k], ny = cy + dy[k];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        int ni = ny * bw + nx;
        if (s_visited[ni] || map[ni] < thr) continue;
        s_visited[ni] = 1;
        if (qt < TV_MAX_CELLS) s_queue[qt++] = (uint16_t)ni;
      }
    }

    if (area < MIN_AREA) continue;
    if (patchCount >= TV_MAX_PATCHES) break;
    patchCount++;
    uint16_t pid = (uint16_t)patchCount;
    for (int q = 0; q < qt; q++) {
      ids[s_queue[q]] = pid;
    }
  }
  return patchCount;
}

int extract_patches(const uint8_t* map, const uint16_t* ids,
                    int bw, int bh, int count, TVPatch* patches) {
  if (!map || !ids || !patches || count <= 0) return 0;
  const int n = count < TV_MAX_PATCHES ? count : TV_MAX_PATCHES;

  for (int p = 0; p < n; p++) {
    patches[p].id = p + 1;
    patches[p].minx = bw; patches[p].miny = bh;
    patches[p].maxx = 0;  patches[p].maxy = 0;
    patches[p].area = 0;
    patches[p].flatness = 0.f;
    patches[p].cx = 0.f; patches[p].cy = 0.f;
  }

  for (int y = 0; y < bh; y++) {
    for (int x = 0; x < bw; x++) {
      int id = ids[y * bw + x];
      if (id < 1 || id > n) continue;
      TVPatch& P = patches[id - 1];
      P.area++;
      P.flatness += map[y * bw + x];
      P.cx += x; P.cy += y;
      if (x < P.minx) P.minx = x;
      if (y < P.miny) P.miny = y;
      if (x > P.maxx) P.maxx = x;
      if (y > P.maxy) P.maxy = y;
    }
  }

  int valid = 0;
  for (int p = 0; p < n; p++) {
    if (patches[p].area <= 0) continue;
    patches[p].flatness /= (patches[p].area * 255.f);
    patches[p].cx /= patches[p].area;
    patches[p].cy /= patches[p].area;
    if (valid != p) patches[valid] = patches[p];
    valid++;
  }
  return valid;
}

int trace_contour(const uint16_t* ids, int bw, int bh, int patchId,
                  int16_t* pts, int maxPts) {
  if (!ids || !pts || maxPts < 4) return 0;

  int sx = -1, sy = -1;
  for (int y = 0; y < bh && sx < 0; y++) {
    for (int x = 0; x < bw; x++) {
      if (ids[y * bw + x] != patchId) continue;
      bool border = false;
      static const int ddx[4] = {1,-1,0,0}, ddy[4] = {0,0,1,-1};
      for (int k = 0; k < 4; k++) {
        int nx = x + ddx[k], ny = y + ddy[k];
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh ||
            ids[ny * bw + nx] != patchId) {
          border = true; break;
        }
      }
      if (border) { sx = x; sy = y; break; }
    }
  }
  if (sx < 0) return 0;

  static const int dx[4] = {1, 0, -1, 0};
  static const int dy[4] = {0, 1,  0,-1};

  auto isPatch = [&](int px, int py) {
    if (px < 0 || py < 0 || px >= bw || py >= bh) return false;
    return ids[py * bw + px] == patchId;
  };

  int x = sx, y = sy, dir = 0, npts = 0;

  for (int step = 0; step < maxPts - 1; step++) {
    pts[npts * 2]     = (int16_t)x;
    pts[npts * 2 + 1] = (int16_t)y;
    npts++;

    int found = -1;
    for (int t = 0; t < 4; t++) {
      int nd = (dir + 3 + t) % 4;
      int nx = x + dx[nd], ny = y + dy[nd];
      if (isPatch(nx, ny)) { found = nd; break; }
    }
    if (found < 0) break;
    x += dx[found];
    y += dy[found];
    dir = found;

    if (x == sx && y == sy && npts > 2) break;
  }

  if (npts > 2 && maxPts >= npts + 1) {
    pts[npts * 2] = pts[0];
    pts[npts * 2 + 1] = pts[1];
    npts++;
  }
  return npts;
}

} // extern C
