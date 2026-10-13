import type { PoseSignals, PoseTrack } from "./pose/types";

/** A downscaled grayscale video frame (values 0..255). */
export interface GrayFrame {
  /** Row-major luminance, length = width * height. */
  data: Float32Array;
  width: number;
  height: number;
  /** Presentation time in seconds. */
  time: number;
}

/** Per-frame motion measurements, relative to the previous sampled frame. */
export interface FrameMotion {
  time: number;
  /** Global (camera) shift of the image content in gray-frame pixels since the previous frame. */
  dx: number;
  dy: number;
  /** Phase-correlation peak height (0..1). Low = unreliable shift or scene change. */
  peak: number;
  /** Mean residual motion after compensating the camera shift (0..255 scale, noise removed). */
  residual: number;
  /** Mean absolute difference between the frames without compensation. */
  rawDiff: number;
  /** Weighted centroid of the residual motion in gray-frame pixels (NaN if no motion). */
  fgX: number;
  fgY: number;
  /** Weighted median row of the motion beside the athlete (the line), NaN if none. */
  lineY: number;
  /** Amount of motion beside the athlete (how much line is visible). */
  lineMass: number;
  /** Centre column of the band where motion keeps happening (the athlete). */
  focusX: number;
  /** Weighted median row of the residual motion inside the focus band. */
  fgYMedian: number;
  /** Row above which most (`lowQuantile`) of the focus band's motion lies: the lowest moving parts. */
  fgYLow: number;
  /** True if this frame starts a new shot (hard cut in the video). */
  cut: boolean;
}

/** Uniformly resampled signals used for cut-point detection (and returned for charts). */
export interface Signals {
  /** Sample rate in Hz. */
  rate: number;
  /** Time of sample 0 in seconds. */
  t0: number;
  /** Foreground motion energy (camera motion removed). */
  motion: number[];
  /** Camera vertical speed (gray-frame px/s, + = image content moves down). */
  camVy: number[];
  /** Estimated vertical position of the athlete in "world" pixels (+ = lower), detrended. */
  height: number[];
  /** Times (s) of detected hard cuts in the video. */
  cuts: number[];
}

export interface CutPoint {
  /** Time of the bottom dead center in seconds. */
  time: number;
  /** 0..1, how confident the detector is. */
  confidence: number;
  /** Time found by the motion analysis, before the pose refinement moved it. */
  motionTime?: number;
  /** "motion" = from camera/foreground motion only, "pose" = adjusted with the body pose (see RefineOptions). */
  method?: "pose" | "motion";
  /** Mean knee angle at the cut point (degrees, 180 = straight), NaN if unknown. */
  knee?: number;
}

export interface AnalysisResult {
  cutPoints: CutPoint[];
  /** Estimated bounce period in seconds (NaN if none found). */
  period: number;
  signals: Signals;
  /** Body pose, when the pose analysis ran. */
  pose?: {
    track: PoseTrack;
    signals: PoseSignals;
  };
}
