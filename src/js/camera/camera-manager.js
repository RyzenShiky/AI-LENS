export class CameraManager {
  constructor(videoElement) {
    this.video = videoElement;
    this.stream = null;
    this.facingMode = "environment";
    this._starting = false;
    this.onTrackEnded = null;
  }

  get isActive() { return !!(this.stream && this.stream.active); }
  get isStarting() { return this._starting; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API unavailable. Use HTTPS or localhost.");
    }
    if (this._starting) throw new Error("Camera already starting.");
    this._starting = true;
    try {
      this._stopTracks();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: this.facingMode },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      this.stream.getVideoTracks().forEach(track => {
        track.onended = () => this.onTrackEnded?.();
      });
      this.video.srcObject = this.stream;
      this.video.style.transform = this.facingMode === "user" ? "scaleX(-1)" : "none";
      await this.video.play();
      await this._waitDims();
      return {
        width: this.video.videoWidth,
        height: this.video.videoHeight,
        facingMode: this.facingMode
      };
    } finally {
      this._starting = false;
    }
  }

  async flip() {
    const prev = this.facingMode;
    this.facingMode = this.facingMode === "environment" ? "user" : "environment";
    try {
      return await this.start();
    } catch (e) {
      this.facingMode = prev;
      throw e;
    }
  }

  stop() {
    this._stopTracks();
    this.video.srcObject = null;
    this.video.style.transform = "none";
  }

  _stopTracks() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
      this.stream = null;
    }
  }

  _waitDims(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (this.video.videoWidth > 0) return resolve();
      const t0 = performance.now();
      const tick = () => {
        if (this.video.videoWidth > 0) return resolve();
        if (performance.now() - t0 > timeoutMs) return reject(new Error("Camera resolution timeout"));
        requestAnimationFrame(tick);
      };
      tick();
    });
  }
}
