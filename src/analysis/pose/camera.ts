import type { FrameMotion } from "../types";

/**
 * Accumulated vertical camera shift over time, in frame-width units, restarting at hard cuts.
 * A point's "world" height (down = +) is its image y minus camY at that time.
 */
export interface CameraPath {
  times: number[];
  camY: number[];
  /** Shot number of each sample (increments at hard cuts). */
  shot: number[];
}

export function cameraPath(motions: FrameMotion[], grayWidth: number): CameraPath {
  const times: number[] = [];
  const camY: number[] = [];
  const shot: number[] = [];
  let cum = 0;
  let s = 0;
  for (const m of motions) {
    if (m.cut) {
      s++;
      cum = 0;
    } else cum += m.dy / grayWidth;
    times.push(m.time);
    camY.push(cum);
    shot.push(s);
  }
  return { times, camY, shot };
}

/** Index of the sample nearest to `t` (binary search). */
export function nearestIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - t) <= Math.abs(times[lo] - t)) return lo - 1;
  return lo;
}

/** Camera offset and shot at time t (linear interpolation within a shot). */
export function cameraAt(path: CameraPath, t: number): { camY: number; shot: number } {
  const i = nearestIndex(path.times, t);
  if (i < 0) return { camY: 0, shot: 0 };
  const j = path.times[i] <= t ? i + 1 : i - 1;
  if (j < 0 || j >= path.times.length || path.shot[j] !== path.shot[i]) return { camY: path.camY[i], shot: path.shot[i] };
  const a = Math.min(i, j);
  const b = Math.max(i, j);
  const f = Math.max(0, Math.min(1, (t - path.times[a]) / (path.times[b] - path.times[a] || 1)));
  return { camY: path.camY[a] * (1 - f) + path.camY[b] * f, shot: path.shot[i] };
}
