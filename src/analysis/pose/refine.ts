import { medianFilter, resampleUniform } from "../signal";
import type { CutPoint } from "../types";
import { cameraAt, type CameraPath } from "./camera";
import { legExtension, legReference, poseFeatures } from "./features";
import type { PoseFeatures, PoseSignals, PoseTrack } from "./types";

export interface RefineOptions {
  /**
   * How the pose may move the motion-based time:
   * - "blend" (default): the mean of the motion time and the "legs" time, where the legs can be
   *   seen to straighten; else the motion time. Two independent estimates average out some noise:
   *   slightly better than either alone on the hand-marked videos (e.g. video-05 0.077 → 0.071 s).
   * - "off": keep the motion time (only annotate the knee angle).
   * - "legs": the moment the legs straighten – the hip-to-feet distance rises through `legStraight`
   *   % of the straight-leg length after being below `legBent` % (the owner marks the BDC about
   *   there in video-01). The knee angle gives the same timing.
   * - "feet": centre of the plateau where the feet (camera-corrected) are lowest.
   */
  mode: "blend" | "off" | "legs" | "feet";
  /** Weight of the knee time in mode "blend" (0..1). */
  blendWeight: number;
  /** Leg extension (% of straight) counted as straight / clearly bent for mode "legs". */
  legStraight: number;
  legBent: number;
  /** Search window around each motion-based cut point (seconds). */
  window: number;
  /** Plateau of the lowest feet: samples within this fraction of the feet's travel below the lowest point. */
  plateauFraction: number;
  /** Fewer usable pose samples than this in the window: keep the motion-based time. */
  minSamples: number;
  /** The feet must travel at least this many torso lengths in the window, else keep the motion-based time. */
  minTravel: number;
}

export const defaultRefineOptions: RefineOptions = {
  mode: "blend",
  blendWeight: 0.5,
  legStraight: 95,
  legBent: 85,
  window: 0.6,
  plateauFraction: 0.3,
  minSamples: 4,
  minTravel: 0.15,
};

export type RefinedCutPoint = CutPoint & Required<Pick<CutPoint, "motionTime" | "method" | "knee">>;

/** Time near t0 where the legs straighten (extension rises through `legStraight` after being bent), or null. */
function legStraightening(features: PoseFeatures[], ref: number, t0: number, o: RefineOptions): number | null {
  const near = features
    .filter((f) => Math.abs(f.time - t0) <= o.window)
    .map((f) => ({ time: f.time, legs: legExtension(f, ref) }))
    .filter((f) => Number.isFinite(f.legs));
  const k = medianFilter(near.map((f) => f.legs), 3);
  let best: number | null = null;
  for (let i = 1; i < near.length; i++) {
    if (!(k[i] >= o.legStraight && k[i - 1] < o.legStraight)) continue;
    const bentBefore = near.some((f, j) => j < i && near[i].time - f.time <= 0.6 && k[j] <= o.legBent);
    if (!bentBefore) continue;
    const t = near[i - 1].time + ((near[i].time - near[i - 1].time) * (o.legStraight - k[i - 1])) / (k[i] - k[i - 1]);
    if (best === null || Math.abs(t - t0) < Math.abs(best - t0)) best = t;
  }
  return best;
}

/** Feet height in "world" units (down = +), corrected for camera tilt. */
function worldFeet(f: PoseFeatures, path: CameraPath): { y: number; shot: number } {
  const c = cameraAt(path, f.time);
  return { y: f.feetY - c.camY, shot: c.shot };
}

/**
 * Moves each motion-based cut point to the centre of the lowest-feet plateau nearby, using only
 * samples where the athlete is upright (standing on the line at the bottom).
 */
export function refineWithPose(
  cutPoints: CutPoint[],
  track: PoseTrack,
  path: CameraPath,
  options: Partial<RefineOptions> = {},
): RefinedCutPoint[] {
  const o = { ...defaultRefineOptions, ...options };
  const features = track.frames.map(poseFeatures);
  const scales = features.map((f) => f.scale).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const scale = scales.length ? scales[scales.length >> 1] : NaN;
  const legRef = legReference(features);

  return cutPoints.map((cp) => {
    const shot = cameraAt(path, cp.time).shot;
    const near = features.filter((f) => Math.abs(f.time - cp.time) <= o.window && f.upright && Number.isFinite(f.feetY));
    const samples = near.map((f) => ({ f, w: worldFeet(f, path) })).filter((s) => s.w.shot === shot);
    const kneeAt = (t: number) => {
      const k = features.filter((f) => Math.abs(f.time - t) <= 0.2 && Number.isFinite(f.knee)).map((f) => f.knee);
      return k.length ? k.reduce((a, b) => a + b, 0) / k.length : NaN;
    };
    const keep: RefinedCutPoint = { ...cp, motionTime: cp.time, method: "motion", knee: kneeAt(cp.time) };
    if (o.mode === "off") return keep;
    if (o.mode === "legs" || o.mode === "blend") {
      const k = legStraightening(features, legRef, cp.time, o);
      if (k === null) return keep;
      const t = o.mode === "legs" ? k : cp.time + o.blendWeight * (k - cp.time);
      return { ...cp, time: t, motionTime: cp.time, method: "pose", knee: kneeAt(t) };
    }
    if (samples.length < o.minSamples || !Number.isFinite(scale)) return keep;
    const ys = medianFilter(samples.map((s) => s.w.y), 3);
    const hi = Math.max(...ys);
    const lo = Math.min(...ys);
    if (hi - lo < o.minTravel * scale) return keep;
    const level = hi - o.plateauFraction * (hi - lo);
    // Only the contiguous plateau around the lowest sample
    const top = ys.indexOf(hi);
    let a = top;
    let b = top;
    while (a > 0 && ys[a - 1] >= level) a--;
    while (b < ys.length - 1 && ys[b + 1] >= level) b++;
    let sum = 0;
    let weighted = 0;
    for (let i = a; i <= b; i++) {
      const w = ys[i] - level + 1e-9;
      sum += w;
      weighted += w * samples[i].f.time;
    }
    const time = weighted / sum;
    return { ...cp, time, motionTime: cp.time, method: "pose", knee: kneeAt(time) };
  });
}

/** Running median of 5 over the finite values (single-frame detection errors are common). */
export function despike(values: number[]): number[] {
  const idx = values.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  const filtered = medianFilter(idx.map((i) => values[i]), 5);
  const out = values.map(() => NaN);
  idx.forEach((i, j) => (out[i] = filtered[j]));
  return out;
}

export function poseSignals(track: PoseTrack, path: CameraPath, rate: number, count: number): PoseSignals {
  const f = track.frames.map(poseFeatures);
  const scales = f.map((x) => x.scale).filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const scale = scales.length ? scales[scales.length >> 1] : 1;
  const grid = (values: number[], times: number[], maxGap: number) => {
    const ok = values.map((v, i) => [times[i], v] as const).filter(([, v]) => Number.isFinite(v));
    const uni = resampleUniform(ok.map((x) => x[0]), ok.map((x) => x[1]), rate, 0, count);
    // Blank out grid points far from any real sample
    return uni.map((v, i) => {
      const t = i / rate;
      const near = ok.some(([tt]) => Math.abs(tt - t) <= maxGap);
      return near ? v : NaN;
    });
  };
  const times = f.map((x) => x.time);
  const feetWorld = f.map((x) => (Number.isFinite(x.feetY) ? (x.feetY - cameraAt(path, x.time).camY) / scale : NaN));
  const finite = feetWorld.filter(Number.isFinite);
  const m = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
  const ref = legReference(f);
  return {
    rate,
    t0: 0,
    knee: grid(despike(f.map((x) => x.knee)), times, 0.25),
    legs: grid(despike(f.map((x) => legExtension(x, ref))), times, 0.25),
    tilt: grid(despike(f.map((x) => Math.abs(x.tilt))), times, 0.25),
    feet: grid(feetWorld.map((v) => v - m), times, 0.25),
  };
}
