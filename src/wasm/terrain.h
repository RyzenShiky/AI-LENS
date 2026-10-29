#pragma once
#include <cstdint>

#ifdef __cplusplus
extern "C" {
#endif

#define TV_BLOCK 8
#define TV_MAX_W 640
#define TV_MAX_H 640
#define TV_MAX_CELLS ((TV_MAX_W/TV_BLOCK)*(TV_MAX_H/TV_BLOCK))
#define TV_MAX_PATCHES 64
#define TV_MAX_CONTOUR 512

void feasibility_map(const uint8_t* rgba, int w, int h, uint8_t* out);

int label_patches(const uint8_t* map, int bw, int bh, uint8_t thr, uint16_t* ids);

// Fixed 48-byte layout for JS ABI (explicit padding)
typedef struct {
  int id;
  int minx, miny, maxx, maxy;
  int area;
  float flatness;
  float cx, cy;
  int _pad[3];   // → 48 bytes total
} TVPatch;

int extract_patches(const uint8_t* map, const uint16_t* ids,
                    int bw, int bh, int count, TVPatch* patches);

int trace_contour(const uint16_t* ids, int bw, int bh, int patchId,
                  int16_t* pts, int maxPts);

#ifdef __cplusplus
}
#endif
