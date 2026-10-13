import { poseBox, poseFeatures } from "./features";
import type { PoseFrame } from "./types";

/**
 * A square crop in video pixels around (cx, cy), turned by `angle` degrees (clockwise in the image),
 * so that a body leaning by `angle` appears upright in the crop.
 */
export interface Crop {
  cx: number;
  cy: number;
  size: number;
  angle: number;
}

/** Square crop around (cx, cy), at most the frame's smaller side, centre kept inside the frame. */
export function squareCrop(cx: number, cy: number, size: number, width: number, height: number, angle = 0): Crop {
  const s = Math.max(16, Math.min(size, width, height));
  return {
    cx: Math.max(s / 2, Math.min(width - s / 2, cx)),
    cy: Math.max(s / 2, Math.min(height - s / 2, cy)),
    size: s,
    angle,
  };
}

/**
 * Crop around a previous pose: its keypoint box, padded, at least `minFraction` of the frame, turned
 * so the torso points up.
 */
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
  const tilt = poseFeatures(pose).tilt;
  return squareCrop((x0 + x1) / 2, (y0 + y1) / 2, size, width, height, Number.isFinite(tilt) ? tilt : 0);
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

/** Maps a point given in crop coordinates (0..1) back to video pixels. */
export function fromCrop(crop: Crop, u: number, v: number): [number, number] {
  const a = (crop.angle * Math.PI) / 180;
  const dx = (u - 0.5) * crop.size;
  const dy = (v - 0.5) * crop.size;
  return [crop.cx + dx * Math.cos(a) - dy * Math.sin(a), crop.cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

/** Smallest difference between two angles in degrees (0..180). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}
