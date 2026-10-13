import type { LineEstimate } from "./line";

/** Body keypoints kept from the pose model, in this order. */
export const KEYPOINTS = [
  "nose",
  "leftShoulder",
  "rightShoulder",
  "leftElbow",
  "rightElbow",
  "leftWrist",
  "rightWrist",
  "leftHip",
  "rightHip",
  "leftKnee",
  "rightKnee",
  "leftAnkle",
  "rightAnkle",
  "leftHeel",
  "rightHeel",
  "leftToe",
  "rightToe",
] as const;

export type KeypointName = (typeof KEYPOINTS)[number];

/** MediaPipe Pose landmark index for each of KEYPOINTS. */
export const MEDIAPIPE_INDEX: Record<KeypointName, number> = {
  nose: 0,
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
  leftHeel: 29,
  rightHeel: 30,
  leftToe: 31,
  rightToe: 32,
};

/**
 * One detected pose. `points` holds x, y, visibility for every entry of KEYPOINTS. x and y are in
 * "frame-width units" (pixels / video width), so x is 0..1 and y is 0..height/width.
 */
export interface PoseFrame {
  time: number;
  points: number[];
  /** Where the detection came from: crop around the predicted pose, crop from the motion focus, whole frame, or filled in between detections. */
  source: "track" | "motion" | "full" | "interpolated";
  /** Experimental: the tensioned line at this moment, if it was found. */
  line?: LineEstimate;
}

export interface PoseTrack {
  keypoints: readonly string[];
  videoWidth: number;
  videoHeight: number;
  frames: PoseFrame[];
  /** Number of samples the pose model was run on, found or not. */
  sampled: number;
  /** Times (s) of samples without a (plausible) pose. */
  missed?: number[];
  /** How many samples were taken in dense mode (fast or unclear movement). */
  dense?: number;
}

/** Per-sample body measures derived from a pose (degrees and frame-width units). */
export interface PoseFeatures {
  time: number;
  /** Knee angles hip–knee–ankle, 180 = straight. NaN if not visible. */
  kneeLeft: number;
  kneeRight: number;
  /** Mean of the visible knee angles. */
  knee: number;
  /** Hip angle shoulder–hip–knee (mean of both sides), 180 = straight body. */
  hip: number;
  /** Torso direction hip → shoulder, degrees from straight up; ±180 = upside down. Positive = leaning right in the image. */
  tilt: number;
  /** Torso length (shoulder centre to hip centre). */
  scale: number;
  /** Distance hip centre → ankle centre (frame-width units); see legExtension for the relative value. */
  legSpan: number;
  /** Image y of the ankles / wrists / hips (mean of visible sides). */
  feetY: number;
  wristsY: number;
  hipsY: number;
  /** Shoulders above hips (|tilt| < 60°). */
  upright: boolean;
}

/** Pose measures on the uniform signal grid, for charts (NaN where no pose). */
export interface PoseSignals {
  rate: number;
  t0: number;
  /** Mean knee angle (degrees). */
  knee: number[];
  /** Hip-to-feet distance in % of the distance with straight legs (100 = legs straight). */
  legs: number[];
  /** Torso tilt, degrees away from upright (0 = upright, 180 = upside down). */
  tilt: number[];
  /** Feet height in torso lengths, camera-corrected (down = +), shot-wise mean removed. */
  feet: number[];
}

