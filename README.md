# TerrainVision 0.4.2

Classical **surface texture** mapping demo. Optional slope only when real depth exists.

## What the patches mean

Patches come from edge-density + texture variance (smooth vs rough), **not** from measured terrain angle.

| Internal class | User label | Meaning |
|----------------|------------|---------|
| GRIP | SMOOTH | Low edge density / smoother texture |
| CHECK | MIXED | Intermediate texture score |
| REJECT | ROUGH | Dense edges / high variance (e.g. scree-like) |

Label line shows **SCORE n** (combined texture/size metric), not a probability.

## Depth modes

| Mode | Badge | Role |
|------|-------|------|
| **fused** | DEPTH XR+AI | XR metric anchors AI dense depth (RANSAC). Highest trust when fit is good. |
| **ai** | DEPTH AI | Local metric depth (model **not bundled** yet). |
| **est** | DEPTH EST | Camera attitude context only. **No terrain slope.** Does not affect patch class. |

### Slope display (only fused/ai)

| Confidence | UI |
|------------|-----|
| High ≥ 0.65 | `~18°` (rounded; no fabricated ± until ramp calibration) |
| Medium ≥ 0.35 | Coarse band e.g. `15–25°` |
| Low | **No slope number** (contours stay class-colored) |

Confidence = product of **min** factors (source, fit, gyro stability, point count, normal consistency). Unknown factors are pessimistic; empty point count → 0.

## Stack

- Camera + Web Worker + dual WASM (scalar / SIMD, selected by actual load)
- Self-hosted OFL fonts (`src/fonts/`)
- Chaikin smoothing only for the few tracks drawn on HUD

## Not included

- Live WebXR depth sampling  
- ONNX depth weights  
- Calibrated slope error bars  

## Disclaimer

Research UI only. **Not** for climbing, navigation, or safety decisions.
