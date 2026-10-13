import { KEYPOINTS, type KeypointName, type PoseFeatures, type PoseFrame } from "./types";

const index = Object.fromEntries(KEYPOINTS.map((k, i) => [k, i])) as Record<KeypointName, number>;

/** Minimum visibility for a keypoint to be used. */
export const MIN_VISIBILITY = 0.3;

export function point(frame: PoseFrame, name: KeypointName): [number, number] | null {
  const i = index[name] * 3;
  return frame.points[i + 2] >= MIN_VISIBILITY ? [frame.points[i], frame.points[i + 1]] : null;
}

/** Angle at b in degrees (0..180) between b→a and b→c. */
export function angleAt(a: [number, number], b: [number, number], c: [number, number]): number {
  const ux = a[0] - b[0];
  const uy = a[1] - b[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const n = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  if (n === 0) return NaN;
  return (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / n))) * 180) / Math.PI;
}

function mid(a: [number, number] | null, b: [number, number] | null): [number, number] | null {
  if (a && b) return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return a ?? b;
}

function meanOf(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

function joint(f: PoseFrame, a: KeypointName, b: KeypointName, c: KeypointName): number {
  const pa = point(f, a);
  const pb = point(f, b);
  const pc = point(f, c);
  return pa && pb && pc ? angleAt(pa, pb, pc) : NaN;
}

export function poseFeatures(f: PoseFrame): PoseFeatures {
  const kneeLeft = joint(f, "leftHip", "leftKnee", "leftAnkle");
  const kneeRight = joint(f, "rightHip", "rightKnee", "rightAnkle");
  const hip = meanOf([joint(f, "leftShoulder", "leftHip", "leftKnee"), joint(f, "rightShoulder", "rightHip", "rightKnee")]);
  const shoulders = mid(point(f, "leftShoulder"), point(f, "rightShoulder"));
  const hips = mid(point(f, "leftHip"), point(f, "rightHip"));
  let tilt = NaN;
  let scale = NaN;
  if (shoulders && hips) {
    const dx = shoulders[0] - hips[0];
    const dy = shoulders[1] - hips[1];
    tilt = (Math.atan2(dx, -dy) * 180) / Math.PI;
    scale = Math.hypot(dx, dy);
  }
  const feet = mid(point(f, "leftAnkle"), point(f, "rightAnkle"));
  const wrists = mid(point(f, "leftWrist"), point(f, "rightWrist"));
  return {
    time: f.time,
    kneeLeft,
    kneeRight,
    knee: meanOf([kneeLeft, kneeRight]),
    hip,
    tilt,
    scale,
    feetY: feet ? feet[1] : NaN,
    wristsY: wrists ? wrists[1] : NaN,
    hipsY: hips ? hips[1] : NaN,
    upright: Number.isFinite(tilt) && Math.abs(tilt) < 60,
  };
}

/** Bounding box [x0, y0, x1, y1] of the visible keypoints, or null. */
export function poseBox(f: PoseFrame): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < f.points.length; i += 3) {
    if (f.points[i + 2] < MIN_VISIBILITY) continue;
    x0 = Math.min(x0, f.points[i]);
    y0 = Math.min(y0, f.points[i + 1]);
    x1 = Math.max(x1, f.points[i]);
    y1 = Math.max(y1, f.points[i + 1]);
  }
  return x0 <= x1 ? [x0, y0, x1, y1] : null;
}
