import { legExtension, legReference, point, poseFeatures } from "./features";
import { despike } from "./refine";
import type { PoseFrame, PoseTrack } from "./types";

/**
 * A summary of what the body does during one bounce (from one BDC to the next): raw material for
 * telling tricks apart later. Angles in degrees, times in seconds.
 */
export interface BounceProfile {
  start: number;
  end: number;
  /** Share of pose samples in the bounce where a pose was found (0..1). */
  coverage: number;
  /** Hip-to-feet distance in % of straight legs at the start BDC, and the smallest one (tuck). */
  legsAtStart: number;
  legsMin: number;
  /** When the smallest leg extension happened, relative to the start (s). */
  legsMinAt: number;
  /** Knee angle at the start BDC (180 = straight). */
  kneeAtStart: number;
  /** Smallest knee angle (tucked legs) and when it happened, relative to the start. */
  kneeMin: number;
  kneeMinAt: number;
  /** Smallest hip angle (piked / folded body). */
  hipMin: number;
  /** Largest torso tilt from upright (180 = upside down). */
  tiltMax: number;
  /** Signed torso rotation in the image plane over the bounce (360 = one flip; + = clockwise in the image). */
  rotation: number;
  /** Time with the body more than 120° from upright. */
  invertedTime: number;
  /** Share of samples with both wrists above the shoulders. */
  armsUp: number;
}

function torsoAngle(f: PoseFrame): number {
  const ls = point(f, "leftShoulder");
  const rs = point(f, "rightShoulder");
  const lh = point(f, "leftHip");
  const rh = point(f, "rightHip");
  const s = [ls, rs].filter((p): p is [number, number] => !!p);
  const h = [lh, rh].filter((p): p is [number, number] => !!p);
  if (!s.length || !h.length) return NaN;
  const sx = s.reduce((a, p) => a + p[0], 0) / s.length;
  const sy = s.reduce((a, p) => a + p[1], 0) / s.length;
  const hx = h.reduce((a, p) => a + p[0], 0) / h.length;
  const hy = h.reduce((a, p) => a + p[1], 0) / h.length;
  return (Math.atan2(sx - hx, -(sy - hy)) * 180) / Math.PI;
}

/** Sum of angle steps, each wrapped to ±180; steps over `maxStep` are treated as detection errors. */
export function unwrappedRotation(angles: number[], maxStep = 100): number {
  let total = 0;
  let prev = NaN;
  for (const a of angles) {
    if (!Number.isFinite(a)) continue;
    if (Number.isFinite(prev)) {
      let d = a - prev;
      d = ((d + 540) % 360) - 180;
      if (Math.abs(d) <= maxStep) total += d;
    }
    prev = a;
  }
  return total;
}

export function bounceProfiles(track: PoseTrack, bdcTimes: number[]): BounceProfile[] {
  const times = [...bdcTimes].sort((a, b) => a - b);
  const legRef = legReference(track.frames.map(poseFeatures));
  const missed = track.missed ?? [];
  const out: BounceProfile[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const start = times[i];
    const end = times[i + 1];
    const frames = track.frames.filter((f) => f.time >= start && f.time < end);
    const feats = frames.map(poseFeatures);
    const finite = (v: number[]) => v.filter(Number.isFinite);
    const knees = despike(feats.map((f) => f.knee));
    let kneeMin = NaN;
    let kneeMinAt = NaN;
    knees.forEach((k, j) => {
      if (Number.isFinite(k) && !(k >= kneeMin)) {
        kneeMin = k;
        kneeMinAt = feats[j].time - start;
      }
    });
    const startFeats = track.frames.filter((f) => Math.abs(f.time - start) <= 0.2).map(poseFeatures);
    const kneeStart = finite(startFeats.map((f) => f.knee));
    const legsStart = finite(startFeats.map((f) => legExtension(f, legRef)));
    const legs = despike(feats.map((f) => legExtension(f, legRef)));
    let legsMin = NaN;
    let legsMinAt = NaN;
    legs.forEach((l, j) => {
      if (Number.isFinite(l) && !(l >= legsMin)) {
        legsMin = l;
        legsMinAt = feats[j].time - start;
      }
    });
    const misses = missed.filter((t) => t >= start && t < end).length;
    const angles = frames.map(torsoAngle);
    const tilts = finite(despike(angles.map(Math.abs)));
    const step = frames.length > 1 ? (frames[frames.length - 1].time - frames[0].time) / (frames.length - 1) : 0;
    const armsUp = frames.filter((f) => {
      const ls = point(f, "leftShoulder");
      const rs = point(f, "rightShoulder");
      const lw = point(f, "leftWrist");
      const rw = point(f, "rightWrist");
      return ls && rs && lw && rw && lw[1] < ls[1] && rw[1] < rs[1];
    }).length;
    out.push({
      start,
      end,
      coverage: frames.length + misses ? frames.length / (frames.length + misses) : 0,
      legsAtStart: legsStart.length ? legsStart.reduce((a, b) => a + b, 0) / legsStart.length : NaN,
      legsMin,
      legsMinAt,
      kneeAtStart: kneeStart.length ? kneeStart.reduce((a, b) => a + b, 0) / kneeStart.length : NaN,
      kneeMin,
      kneeMinAt,
      hipMin: Math.min(...finite(despike(feats.map((f) => f.hip))), Infinity),
      tiltMax: tilts.length ? Math.max(...tilts) : NaN,
      rotation: unwrappedRotation(angles),
      invertedTime: tilts.filter((t) => t > 120).length * step,
      armsUp: frames.length ? armsUp / frames.length : NaN,
    });
    const last = out[out.length - 1];
    if (!Number.isFinite(last.hipMin)) last.hipMin = NaN;
  }
  return out;
}
