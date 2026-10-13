import {
  autocorrelation,
  fillGaps,
  findPeaks,
  gaussianSmooth,
  medianFilter,
  movingAverage,
  resampleUniform,
  std,
  type Peak,
} from "./signal";
import type { AnalysisResult, CutPoint, FrameMotion, Signals } from "./types";

export interface DetectOptions {
  /** Rate of the uniform signal grid in Hz. */
  rate: number;
  /** Smoothing of the height signal (seconds, Gaussian sigma). */
  smoothSeconds: number;
  /** Window of the moving average removed from the height signal (seconds). */
  detrendSeconds: number;
  /** Search range for the bounce period (seconds). */
  minPeriod: number;
  maxPeriod: number;
  /** Peaks need at least this prominence (in standard deviations of the height signal). */
  minProminence: number;
  /** Peaks closer than this fraction of the period are merged (the more prominent one wins). */
  minSpacing: number;
  /** Shots shorter than this (seconds) are ignored. */
  minShotSeconds: number;
  /**
   * The bottom is a plateau rather than a sharp peak. The cut point is the centre of the part of the
   * plateau within this fraction of the peak's prominence below the peak (0 = the peak itself).
   */
  plateauFraction: number;
  /** Peaks closer than this (seconds) to a hard cut in the video are dropped. */
  edgeSeconds: number;
}

export const defaultDetectOptions: DetectOptions = {
  rate: 15,
  smoothSeconds: 0.12,
  detrendSeconds: 3.5,
  minPeriod: 1.8,
  maxPeriod: 5.5,
  minProminence: 0.5,
  minSpacing: 0.65,
  minShotSeconds: 1.5,
  plateauFraction: 0.3,
  edgeSeconds: 0.4,
};

interface Shot {
  start: number;
  /** Whether the shot starts / ends at a hard cut (not at the start / end of the video). */
  cutBefore: boolean;
  cutAfter: boolean;
  /** Uniform grid index of the first sample. */
  offset: number;
  height: number[];
}

/**
 * Turns per-frame motion into bottom-dead-center (BDC) cut points.
 *
 * Idea: the camera operator follows the athlete, so the accumulated vertical camera shift tracks
 * the athlete's height; the position of the remaining (foreground) motion in the frame adds what
 * the camera did not follow (fixed camera, lag). The athlete's lowest points are the BDCs.
 */
export function detectCutPoints(
  motions: FrameMotion[],
  duration: number,
  options: Partial<DetectOptions> = {},
): AnalysisResult {
  const o = { ...defaultDetectOptions, ...options };
  const rate = o.rate;
  const count = Math.max(1, Math.floor(duration * rate) + 1);
  const times = motions.map((m) => m.time);

  const motion = gaussianSmooth(
    resampleUniform(times, motions.map((m) => m.residual), rate, 0, count),
    o.smoothSeconds * rate,
  );
  const camVy = gaussianSmooth(
    resampleUniform(times, motions.map((m, i) => (i > 0 ? m.dy / Math.max(1e-3, m.time - motions[i - 1].time) : 0)), rate, 0, count),
    o.smoothSeconds * rate,
  );

  // Split into shots at hard cuts
  const cuts = motions.filter((m) => m.cut).map((m) => m.time);
  const bounds = [0, ...cuts, duration];
  const shots: Shot[] = [];
  const height = new Array<number>(count).fill(0);
  for (let s = 0; s + 1 < bounds.length; s++) {
    const a = bounds[s];
    const b = bounds[s + 1];
    const seg = motions.filter((m) => m.time >= a && m.time < b && !(m.cut && m.time === a));
    const first = Math.ceil(a * rate);
    const last = Math.min(count - 1, Math.floor(b * rate - 1e-9));
    if (seg.length < 3 || b - a < o.minShotSeconds || last <= first) continue;
    let cum = 0;
    const raw: number[] = [];
    const fgY = fillGaps(medianFilter(seg.map((m) => m.fgY), 5));
    seg.forEach((m, i) => {
      if (!(m.cut && i === 0)) cum += m.dy;
      raw.push(fgY[i] - cum);
    });
    const uni = resampleUniform(seg.map((m) => m.time), raw, rate, first / rate, last - first + 1);
    const smooth = gaussianSmooth(uni, o.smoothSeconds * rate);
    const trend = movingAverage(smooth, Math.round(o.detrendSeconds * rate));
    const h = smooth.map((v, i) => v - trend[i]);
    shots.push({ start: a, cutBefore: s > 0, cutAfter: s + 2 < bounds.length, offset: first, height: h });
    h.forEach((v, i) => (height[first + i] = v));
  }

  const period = estimatePeriod(shots, o);
  const cutPoints: CutPoint[] = [];
  for (const shot of shots) cutPoints.push(...shotPeaks(shot, period, o));
  cutPoints.sort((a, b) => a.time - b.time);

  const signals: Signals = { rate, t0: 0, motion, camVy, height, cuts };
  return { cutPoints, period, signals };
}

function estimatePeriod(shots: Shot[], o: DetectOptions): number {
  const minLag = Math.round(o.minPeriod * o.rate);
  const maxLag = Math.round(o.maxPeriod * o.rate);
  const acc = new Array<number>(maxLag - minLag + 1).fill(0);
  let weight = 0;
  for (const shot of shots) {
    if (shot.height.length < minLag * 2) continue;
    const ac = autocorrelation(shot.height, minLag, Math.min(maxLag, shot.height.length - minLag));
    ac.forEach((v, i) => (acc[i] += v * shot.height.length));
    weight += shot.height.length;
  }
  if (!weight) return NaN;
  // Take the first clear maximum, not a multiple of the period
  const peaks = findPeaks(acc.map((v) => v / weight)).filter((p) => p.value > 0.1);
  if (!peaks.length) return NaN;
  const best = Math.max(...peaks.map((p) => p.value));
  const first = peaks.find((p) => p.value > 0.7 * best)!;
  return (minLag + first.position) / o.rate;
}

function shotPeaks(shot: Shot, period: number, o: DetectOptions): CutPoint[] {
  const h = shot.height;
  const sd = std(h) || 1;
  const T = Number.isFinite(period) ? period : (o.minPeriod + o.maxPeriod) / 2;
  const minDist = o.minSpacing * T * o.rate;
  const edge = o.edgeSeconds * o.rate;
  const candidates = findPeaks(h)
    .filter((p) => p.prominence >= o.minProminence * sd)
    .filter((p) => !(shot.cutBefore && p.position < edge) && !(shot.cutAfter && p.position > h.length - 1 - edge))
    .sort((a, b) => b.prominence - a.prominence);
  const centred = candidates.map((p) => ({ ...p, centre: plateauCentre(h, p, o.plateauFraction, (T / 2) * o.rate) }));
  const chosen: typeof centred = [];
  for (const p of centred) {
    if (chosen.every((c) => Math.abs(c.centre - p.centre) >= minDist)) chosen.push(p);
  }
  const maxProm = Math.max(...chosen.map((c) => c.prominence), 1e-9);
  return chosen.map((p) => ({
    time: (shot.offset + p.centre) / o.rate,
    confidence: Math.min(1, p.prominence / Math.max(maxProm * 0.6, 2 * sd)),
  }));
}

/** Weighted centre of the samples around a peak that lie within `fraction` of its prominence. */
function plateauCentre(h: number[], p: Peak, fraction: number, maxReach: number): number {
  if (fraction <= 0) return p.position;
  const level = p.value - fraction * p.prominence;
  let a = p.index;
  let b = p.index;
  while (a > 0 && p.index - a < maxReach && h[a - 1] >= level) a--;
  while (b < h.length - 1 && b - p.index < maxReach && h[b + 1] >= level) b++;
  let sum = 0;
  let weighted = 0;
  for (let i = a; i <= b; i++) {
    const w = h[i] - level;
    sum += w;
    weighted += w * i;
  }
  return sum > 0 ? weighted / sum : p.position;
}
