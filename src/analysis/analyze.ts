import { detectCutPoints, type DetectOptions } from "./detect";
import { MotionTracker, type MotionOptions } from "./motion";
import type { AnalysisResult, FrameMotion } from "./types";
import { loadVideo, sampleFrames, type FrameSourceOptions } from "./videoFrames";

export interface AnalyzeOptions {
  frames?: Partial<FrameSourceOptions>;
  motion?: Partial<MotionOptions>;
  detect?: Partial<DetectOptions>;
}

/** Browser entry point: analyze(videoFile) → { cutPoints, signals }. */
export async function analyze(video: Blob | HTMLVideoElement, options: AnalyzeOptions = {}): Promise<AnalysisResult> {
  const el = video instanceof HTMLVideoElement ? video : await loadVideo(video);
  const tracker = new MotionTracker(options.motion);
  const motions: FrameMotion[] = [];
  const duration = await sampleFrames(
    el,
    (frame) => {
      const m = tracker.push(frame);
      if (m) motions.push(m);
    },
    options.frames,
  );
  if (!(video instanceof HTMLVideoElement)) URL.revokeObjectURL(el.src);
  return detectCutPoints(motions, duration, options.detect);
}
