import { PhaseCorrelator } from "./phaseCorrelation";
import type { FrameMotion, GrayFrame } from "./types";

export interface MotionOptions {
  /** Longer side of the phase-correlation grid (power of two). */
  correlationSize: number;
  /** Pixels ignored at every border when measuring residual motion. */
  margin: number;
  /** Residual differences below max(minNoise, noiseFactor * median) count as noise. */
  minNoise: number;
  noiseFactor: number;
  /** Phase-correlation peak below this, together with a jump in raw difference, means a hard cut. */
  cutPeak: number;
  cutDiff: number;
}

export const defaultMotionOptions: MotionOptions = {
  correlationSize: 128,
  margin: 4,
  minNoise: 6,
  noiseFactor: 2.5,
  cutPeak: 0.06,
  cutDiff: 30,
};

function pow2Floor(n: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, n)));
}

/** Box-resamples a gray frame to a w x h grid. */
export function resample(frame: GrayFrame, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const sx = frame.width / w;
  const sy = frame.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * frame.width;
        for (let xx = x0; xx < x1; xx++) sum += frame.data[row + xx];
      }
      out[y * w + x] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * Feeds frames one by one and measures camera shift and remaining (foreground) motion
 * relative to the previous frame.
 */
export class MotionTracker {
  private readonly opts: MotionOptions;
  private correlator: PhaseCorrelator | null = null;
  private prev: GrayFrame | null = null;
  private prevSpectrum: { re: Float64Array; im: Float64Array } | null = null;
  private readonly hist = new Uint32Array(256);

  constructor(options: Partial<MotionOptions> = {}) {
    this.opts = { ...defaultMotionOptions, ...options };
  }

  /** Returns the motion relative to the previous frame, or null for the first frame. */
  push(frame: GrayFrame): FrameMotion | null {
    if (!this.correlator) {
      const long = this.opts.correlationSize;
      const ratio = Math.min(frame.width, frame.height) / Math.max(frame.width, frame.height);
      const short = pow2Floor(long * ratio * 1.25);
      const [w, h] = frame.width >= frame.height ? [long, short] : [short, long];
      this.correlator = new PhaseCorrelator(w, h);
    }
    const c = this.correlator;
    const spectrum = c.spectrum(resample(frame, c.width, c.height));
    const prev = this.prev;
    const prevSpectrum = this.prevSpectrum;
    this.prev = frame;
    this.prevSpectrum = spectrum;
    if (!prev || !prevSpectrum) return null;
    if (prev.width !== frame.width || prev.height !== frame.height) {
      throw new Error("Frame size changed during analysis");
    }

    const shift = c.correlate(prevSpectrum, spectrum);
    const dx = (shift.dx * frame.width) / c.width;
    const dy = (shift.dy * frame.height) / c.height;
    const res = this.residual(prev, frame, dx, dy);
    const cut = shift.peak < this.opts.cutPeak && res.rawDiff > this.opts.cutDiff;
    return { time: frame.time, dx, dy, peak: shift.peak, ...res, cut };
  }

  private residual(prev: GrayFrame, cur: GrayFrame, dx: number, dy: number) {
    const { width: w, height: h } = cur;
    const m = this.opts.margin + Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)));
    const diff = new Float32Array(w * h);
    const hist = this.hist;
    hist.fill(0);
    let rawSum = 0;
    let count = 0;
    const p = prev.data;
    for (let y = m; y < h - m; y++) {
      const sy = y - dy;
      const y0 = Math.floor(sy);
      const fy = sy - y0;
      for (let x = m; x < w - m; x++) {
        const sx = x - dx;
        const x0 = Math.floor(sx);
        const fx = sx - x0;
        const i0 = y0 * w + x0;
        const v =
          (p[i0] * (1 - fx) + p[i0 + 1] * fx) * (1 - fy) +
          (p[i0 + w] * (1 - fx) + p[i0 + w + 1] * fx) * fy;
        const i = y * w + x;
        const d = Math.abs(cur.data[i] - v);
        diff[i] = d;
        hist[Math.min(255, d | 0)]++;
        rawSum += Math.abs(cur.data[i] - p[i]);
        count++;
      }
    }
    let median = 0;
    for (let acc = 0; median < 255; median++) {
      acc += hist[median];
      if (acc >= count / 2) break;
    }
    const thr = Math.max(this.opts.minNoise, this.opts.noiseFactor * (median + 0.5));
    let sum = 0;
    let sx = 0;
    let sy = 0;
    for (let y = m; y < h - m; y++) {
      for (let x = m; x < w - m; x++) {
        const d = diff[y * w + x] - thr;
        if (d > 0) {
          sum += d;
          sx += d * x;
          sy += d * y;
        }
      }
    }
    return {
      residual: count ? sum / count : 0,
      rawDiff: count ? rawSum / count : 0,
      fgX: sum > 0 ? sx / sum : NaN,
      fgY: sum > 0 ? sy / sum : NaN,
    };
  }
}
