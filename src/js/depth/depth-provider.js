/**
 * Depth provider contract:
 *   id: string
 *   confidence(): number 0..1
 *   async init()
 *   async depth(frameCtx) → { data: Float32Array|null, w, h, metric: boolean, slopeDeg?, slopeConf? }
 *
 * Levels:
 *   A XRDepth — WebXR depth-sensing (Chrome Android / ARCore) when available
 *   B MLDepth — placeholder for ONNX metric depth (not bundled yet)
 *   C GroundPlaneEstimate — pitch + assumed camera height
 */

/** Approximate FOV (degrees) — no browser API for intrinsics */
const APPROX_VFOV_DEG = 60;
const CAM_HEIGHT_M = 1.4; // assumed when holding phone

function screenAngle() {
  return screen.orientation?.angle ?? 0;
}

/** DeviceOrientation → gravity vector in camera-ish frame (rough) */
export class OrientationHelper {
  constructor() {
    this.beta = 0;  // pitch-ish
    this.gamma = 0; // roll-ish
    this.alpha = 0;
    this.ok = false;
    this._on = (e) => {
      if (e.beta == null) return;
      this.beta = e.beta;
      this.gamma = e.gamma ?? 0;
      this.alpha = e.alpha ?? 0;
      this.ok = true;
    };
  }
  async start() {
    // iOS: must be called directly from user gesture — caller should not await fonts first
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      try {
        const p = await DeviceOrientationEvent.requestPermission();
        if (p !== "granted") return false;
      } catch (_) { return false; }
    }
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      try { await DeviceMotionEvent.requestPermission(); } catch (_) {}
    }
    window.addEventListener("deviceorientation", this._on, true);
    window.addEventListener("devicemotion", this._onMotion, true);
    return true;
  }
  stop() {
    window.removeEventListener("deviceorientation", this._on, true);
    window.removeEventListener("devicemotion", this._onMotion, true);
  }
  /**
   * Camera pitch vs horizon in degrees.
   * Best-effort camera attitude (NOT terrain slope). Sign/axis differ by OS —
   * log values while aiming at the floor before relying on the sign.
   * W3C: beta=0 face-up (rear camera toward ground). Do not treat as slope.
   */
  cameraPitchDeg() {
    // Provisional: beta relative to upright; validate on device before use
    let pitch = this.beta - 90;
    const ang = screenAngle();
    if (ang === 90 || ang === 270 || ang === -90) {
      // Landscape: gamma dominates tilt toward ground — keep sign
      pitch = this.gamma;
    }
    return Math.max(-89, Math.min(89, pitch));
  }

  /** Gyro magnitude rad/s if DeviceMotion available */
  gyroMag = null;
  _onMotion = (e) => {
    const r = e.rotationRate;
    if (!r) return;
    const x = r.alpha || 0, y = r.beta || 0, z = r.gamma || 0;
    // deg/s magnitude — only set when we actually receive motion data
    this.gyroMag = Math.sqrt(x * x + y * y + z * z) * (Math.PI / 180);
  };
}

/** C — ground plane from pitch + height */
export class GroundPlaneEstimate {
  id = "EST";
  constructor(orient) {
    this.orient = orient;
  }
  confidence() {
    return this.orient?.ok ? 0.25 : 0.1;
  }
  async init() {}
  async depth() {
    const pitch = this.orient?.cameraPitchDeg?.() ?? null;
    return {
      data: null,
      w: 0, h: 0,
      metric: false,
      // EST does not measure terrain slope — camera attitude only
      slopeDeg: null,
      slopeConf: 0,
      cameraPitchDeg: pitch,
      gyroMag: this.orient?.gyroMag ?? null
    };
  }
}

/** A — WebXR depth sensing (feature-detect only until user starts AR session) */
export class XRDepth {
  id = "XR";
  session = null;
  conf = 0;
  confidence() { return this.conf; }
  async init() {
    // Actual session must start from user gesture in main — here only probe support
    if (!navigator.xr) return false;
    try {
      const ok = await navigator.xr.isSessionSupported("immersive-ar");
      this.conf = ok ? 0.5 : 0; // real conf after session
      return ok;
    } catch (_) {
      return false;
    }
  }
  async depth() {
    // Without active XR session we cannot sample depth; fall through
    return { data: null, w: 0, h: 0, metric: true, slopeDeg: null, slopeConf: 0 };
  }
  async tryStartSession() {
    if (!navigator.xr) return null;
    try {
      this.session = await navigator.xr.requestSession("immersive-ar", {
        optionalFeatures: ["depth-sensing", "camera-access", "dom-overlay"],
        depthSensing: {
          usagePreference: ["cpu-optimized"],
          dataFormatPreference: ["float32", "luminance-alpha"]
        },
        domOverlay: { root: document.body }
      });
      this.conf = 0.85;
      return this.session;
    } catch (e) {
      console.warn("XR session failed", e);
      this.conf = 0;
      return null;
    }
  }
}

/** B — ONNX metric depth placeholder (load later) */
export class MLDepth {
  id = "AI";
  conf = 0;
  confidence() { return this.conf; }
  async init() {
    // Model not bundled in this build
    this.conf = 0;
    return false;
  }
  async depth() {
    return { data: null, w: 0, h: 0, metric: true, slopeDeg: null, slopeConf: 0 };
  }
}

export async function xrDepthUsable() {
  if (!navigator.xr) return false;
  try {
    return await navigator.xr.isSessionSupported("immersive-ar");
  } catch (_) {
    return false;
  }
}

export async function mlDepthUsable() {
  // Would check WebGPU / wasm + model presence
  return false;
}

/**
 * Pick best available provider. Hysteresis: caller should keep the choice.
 */
export async function pickDepthProvider(orient) {
  // XR/AI only selected when they can actually supply depth.
  // Until then EST is honest camera-attitude context, not terrain slope.
  if (await mlDepthUsable()) {
    const ml = new MLDepth();
    if (await ml.init()) return ml;
  }
  return new GroundPlaneEstimate(orient);
}

/** Probe XR support for future AR button — does not activate provider */
export async function probeXR() {
  return xrDepthUsable();
}
