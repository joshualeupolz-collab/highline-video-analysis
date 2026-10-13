import { poseBox } from "./features";
import type { PoseFrame } from "./types";

/** A square crop in video pixels. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

/** Square crop around (cx, cy), shifted to stay inside a width x height frame. */
export function squareCrop(cx: number, cy: number, size: number, width: number, height: number): Crop {
  const s = Math.max(16, Math.min(size, width, height));
  return {
    x: Math.max(0, Math.min(width - s, cx - s / 2)),
    y: Math.max(0, Math.min(height - s, cy - s / 2)),
    size: s,
  };
}

/** Crop around a previous pose: its keypoint box, padded, at least `minFraction` of the frame. */
export function cropFromPose(
  pose: PoseFrame,
  width: number,
  height: number,
  padding = 1.8,
  minFraction = 0.15,
): Crop | null {
  const b = poseBox(pose);
  if (!b) return null;
  // Pose coordinates are in frame-width units
  const [x0, y0, x1, y1] = b.map((v) => v * width);
  const size = Math.max((x1 - x0) * padding, (y1 - y0) * padding, minFraction * Math.min(width, height));
  return squareCrop((x0 + x1) / 2, (y0 + y1) / 2, size, width, height);
}

/** Crop around the motion focus (gray-frame coordinates scaled to video pixels). */
export function cropFromMotion(
  focusX: number,
  focusY: number,
  grayWidth: number,
  width: number,
  height: number,
  fraction = 0.5,
): Crop | null {
  if (!Number.isFinite(focusX) || !Number.isFinite(focusY)) return null;
  const k = width / grayWidth;
  return squareCrop(focusX * k, focusY * k, fraction * Math.min(width, height), width, height);
}
