import { fft2d, isPowerOfTwo } from "./fft";

/**
 * Estimates the translation between two images with phase correlation.
 * Images are given as their (windowed) 2D spectra so each frame is transformed only once.
 */
export class PhaseCorrelator {
  readonly width: number;
  readonly height: number;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  constructor(width: number, height: number) {
    if (!isPowerOfTwo(width) || !isPowerOfTwo(height)) {
      throw new Error("PhaseCorrelator needs power-of-two sizes");
    }
    this.width = width;
    this.height = height;
    this.window = new Float64Array(width * height);
    for (let y = 0; y < height; y++) {
      const wy = 0.5 - 0.5 * Math.cos((2 * Math.PI * (y + 0.5)) / height);
      for (let x = 0; x < width; x++) {
        const wx = 0.5 - 0.5 * Math.cos((2 * Math.PI * (x + 0.5)) / width);
        this.window[y * width + x] = wx * wy;
      }
    }
    this.re = new Float64Array(width * height);
    this.im = new Float64Array(width * height);
  }

  /** Returns the spectrum of a width x height image (mean removed, Hann windowed). */
  spectrum(pixels: ArrayLike<number>): { re: Float64Array; im: Float64Array } {
    const n = this.width * this.height;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += pixels[i];
    mean /= n;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (pixels[i] - mean) * this.window[i];
    fft2d(re, im, this.width, this.height);
    return { re, im };
  }

  /**
   * Shift (dx, dy) such that `b` ≈ `a` moved by (dx, dy), plus the correlation peak height.
   */
  correlate(
    a: { re: Float64Array; im: Float64Array },
    b: { re: Float64Array; im: Float64Array },
  ): { dx: number; dy: number; peak: number } {
    const { width: w, height: h, re, im } = this;
    const n = w * h;
    // conj(A) * B, normalised
    for (let i = 0; i < n; i++) {
      const r = a.re[i] * b.re[i] + a.im[i] * b.im[i];
      const m = a.re[i] * b.im[i] - a.im[i] * b.re[i];
      const mag = Math.hypot(r, m) + 1e-9;
      re[i] = r / mag;
      im[i] = m / mag;
    }
    fft2d(re, im, w, h, true);
    let best = 0;
    for (let i = 1; i < n; i++) if (re[i] > re[best]) best = i;
    const px = best % w;
    const py = (best - px) / w;
    const at = (x: number, y: number) => re[((y + h) % h) * w + ((x + w) % w)];
    const sub = (l: number, c: number, r: number) => {
      const d = l - 2 * c + r;
      return d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / d)) : 0;
    };
    let dx = px + sub(at(px - 1, py), at(px, py), at(px + 1, py));
    let dy = py + sub(at(px, py - 1), at(px, py), at(px, py + 1));
    if (dx > w / 2) dx -= w;
    if (dy > h / 2) dy -= h;
    return { dx, dy, peak: re[best] };
  }
}
