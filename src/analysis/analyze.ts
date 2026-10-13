import { detectCutPoints, type DetectOptions } from "./detect";
import { MotionTracker, type MotionOptions } from "./motion";
import { cameraPath } from "./pose/camera";
import type { PoseOptions } from "./pose/landmarker";
import { poseSignals, refineWithPose, type RefineOptions } from "./pose/refine";
import type { AnalysisResult, FrameMotion } from "./types";
import { defaultFrameSourceOptions, loadVideo, sampleFrames, type FrameSourceOptions } from "./videoFrames";

export interface AnalyzeOptions {
  frames?: Partial<FrameSourceOptions>;
  motion?: Partial<MotionOptions>;
  detect?: Partial<DetectOptions>;
  /** Run the body pose model too (slower; loads ~20 MB of model and wasm the first time). */
  pose?: boolean | Partial<PoseOptions>;
  refine?: Partial<RefineOptions>;
  /** Called with the phase ("motion" or "pose") and its progress 0..1. */
  onProgress?: (phase: "motion" | "pose", fraction: number) => void;
  signal?: AbortSignal;
}

/** Browser entry point: analyze(videoFile) → { cutPoints, period, signals, pose? }. */
export async function analyze(video: Blob | HTMLVideoElement, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const el = video instanceof HTMLVideoElement ? video : await loadVideo(video);
  try {
    const tracker = new MotionTracker(options.motion);
    const motions: FrameMotion[] = [];
    const frameOptions = { ...defaultFrameSourceOptions, ...options.frames };
    const duration = await sampleFrames(
      el,
      (frame) => {
        const m = tracker.push(frame);
        if (m) motions.push(m);
      },
      {
        signal: options.signal,
        onProgress: (f) => options.onProgress?.("motion", f),
        ...frameOptions,
      },
    );
    const result = detectCutPoints(motions, duration, options.detect);
    if (!options.pose) return result;

    const { trackPose } = await import("./pose/landmarker");
    const poseOptions = typeof options.pose === "object" ? options.pose : {};
    const track = await trackPose(el, motions, {
      grayWidth: frameOptions.width,
      signal: options.signal,
      onProgress: (f) => options.onProgress?.("pose", f),
      ...poseOptions,
    });
    const path = cameraPath(motions, frameOptions.width);
    return {
      ...result,
      cutPoints: refineWithPose(result.cutPoints, track, path, options.refine),
      pose: { track, signals: poseSignals(track, path, result.signals.rate, result.signals.height.length) },
    };
  } finally {
    if (!(video instanceof HTMLVideoElement)) URL.revokeObjectURL(el.src);
  }
}
