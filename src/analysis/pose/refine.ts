import { medianFilter, resampleUniform } from "../signal";
import type { CutPoint } from "../types";
import { cameraAt, type CameraPath } from "./camera";
import { poseFeatures } from "./features";
import type { PoseFeatures, PoseSignals, PoseTrack } from "./types";

export interface RefineOptions {
  /**
   * How the pose may move the motion-based time:
   * - "off": keep it (only annotate the knee angle). Default: on the hand-marked videos the motion
   *   time is already within ~0.1 s of the hand marks, and neither pose method beat it.
   * - "knee": the moment the knees straighten (knee angle rises through `kneeStraight` after being
   *   below `kneeBent`), which is when the owner marks the BDC in video-01.
   * - "feet": centre of the plateau where the feet (camera-corrected) are lowest.
   */
  mode: "off" | "knee" | "feet";
  /** Knee angle (degrees) counted as straight / clearly bent for mode "knee". */
  kneeStraight: number;
  kneeBent: number;
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
  mode: "off",
  kneeStraight: 165,
  kneeBent: 150,
  window: 0.6,
  plateauFraction: 0.3,
  minSamples: 4,
  minTravel: 0.15,
};

export type RefinedCutPoint = CutPoint & Required<Pick<CutPoint, "motionTime" | "method" | "knee">>;

/** Time near t0 where the knee angle rises through `kneeStraight` after being bent, or null. */
function kneeStraightening(features: PoseFeatures[], t0: number, o: RefineOptions): number | null {
  const near = features.filter((f) => Math.abs(f.time - t0) <= o.window && Number.isFinite(f.knee));
  const k = medianFilter(near.map((f) => f.knee), 3);
  let best: number | null = null;
  for (let i = 1; i < near.length; i++) {
    if (!(k[i] >= o.kneeStraight && k[i - 1] < o.kneeStraight)) continue;
    const bentBefore = near.some((f, j) => j < i && near[i].time - f.time <= 0.6 && k[j] <= o.kneeBent);
    if (!bentBefore) continue;
    const t = near[i - 1].time + ((near[i].time - near[i - 1].time) * (o.kneeStraight - k[i - 1])) / (k[i] - k[i - 1]);
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
    if (o.mode === "knee") {
      const t = kneeStraightening(features, cp.time, o);
      return t === null ? keep : { ...cp, time: t, motionTime: cp.time, method: "pose", knee: kneeAt(t) };
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
  return {
    rate,
    t0: 0,
    knee: grid(despike(f.map((x) => x.knee)), times, 0.25),
    tilt: grid(despike(f.map((x) => Math.abs(x.tilt))), times, 0.25),
    feet: grid(feetWorld.map((v) => v - m), times, 0.25),
  };
}
