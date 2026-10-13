/**
 * Browser pose tracking with MediaPipe Pose Landmarker. Runs the model on a square crop around the
 * athlete (from the previous pose, else from the motion analysis, else the whole frame), which
 * finds people much smaller than the model would on the full frame.
 */
import type { FrameMotion } from "../types";
import { playFrames } from "../videoFrames";
import { cropFromMotion, cropFromPose, type Crop } from "./roi";
import { KEYPOINTS, MEDIAPIPE_INDEX, type PoseFrame, type PoseTrack } from "./types";

export type PoseModel = "lite" | "full" | "heavy";

export interface PoseOptions {
  /** Pose samples per second of video. */
  fps: number;
  model: PoseModel;
  /** Folder with the MediaPipe wasm files. Tried in order; the first that answers is used. */
  wasmBases: string[];
  /** Model file URLs per model, tried in order. */
  modelUrls: (model: PoseModel) => string[];
  /** Side of the square image the crop is scaled to before running the model. */
  inputSize: number;
  /** Width of the gray frames used by the motion analysis (to place crops). */
  grayWidth: number;
  minConfidence: number;
  /** "GPU" (falls back to CPU if unavailable) or "CPU". GPU is faster on phones; without a real GPU it is very slow. */
  delegate: "GPU" | "CPU";
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const VERSION = "1.0.1";

export const defaultPoseOptions: PoseOptions = {
  fps: 8,
  model: "full",
  wasmBases: ["./mediapipe", `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`],
  modelUrls: (m) => [
    `./mediapipe/pose_landmarker_${m}.task`,
    `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`,
  ],
  inputSize: 256,
  grayWidth: 160,
  minConfidence: 0.3,
  delegate: "GPU",
};

async function firstReachable(urls: string[], probe: (u: string) => string): Promise<string> {
  for (const u of urls) {
    try {
      // GET and drop the body: some static hosts do not answer HEAD
      const r = await fetch(probe(u));
      void r.body?.cancel();
      if (r.ok) return u;
    } catch {
      /* try the next one */
    }
  }
  throw new Error(`None of these could be loaded: ${urls.join(", ")}`);
}

type Landmarker = {
  detect(image: CanvasImageSource): { landmarks: { x: number; y: number; visibility?: number }[][] };
  close(): void;
};

export async function createLandmarker(o: PoseOptions): Promise<Landmarker> {
  const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
  const wasmBase = await firstReachable(o.wasmBases, (u) => `${u}/vision_wasm_internal.js`);
  const modelUrl = await firstReachable(o.modelUrls(o.model), (u) => u);
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  const make = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelUrl, delegate },
      runningMode: "IMAGE",
      numPoses: 1,
      minPoseDetectionConfidence: o.minConfidence,
      minPosePresenceConfidence: o.minConfidence,
      minTrackingConfidence: o.minConfidence,
    });
  if (o.delegate === "GPU") {
    try {
      return (await make("GPU")) as unknown as Landmarker;
    } catch {
      /* no WebGL2: use the CPU */
    }
  }
  return (await make("CPU")) as unknown as Landmarker;
}

/** Runs the pose model over the whole video. `motions` (optional) helps to find small athletes. */
export async function trackPose(
  video: HTMLVideoElement,
  motions: FrameMotion[],
  options: Partial<PoseOptions> = {},
): Promise<PoseTrack> {
  const o = { ...defaultPoseOptions, ...options };
  const landmarker = await createLandmarker(o);
  const W = video.videoWidth;
  const H = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = o.inputSize;
  canvas.height = o.inputSize;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const frames: PoseFrame[] = [];
  let sampled = 0;
  let last: PoseFrame | null = null;
  let mi = 0;

  const run = (crop: Crop | null): number[] | null => {
    let res;
    if (crop) {
      ctx.drawImage(video, crop.x, crop.y, crop.size, crop.size, 0, 0, o.inputSize, o.inputSize);
      res = landmarker.detect(canvas);
    } else res = landmarker.detect(video);
    const lm = res.landmarks[0];
    if (!lm) return null;
    const points: number[] = [];
    for (const k of KEYPOINTS) {
      const p = lm[MEDIAPIPE_INDEX[k]];
      const px = crop ? crop.x + p.x * crop.size : p.x * W;
      const py = crop ? crop.y + p.y * crop.size : p.y * H;
      points.push(round(px / W), round(py / W), round(p.visibility ?? 1, 2));
    }
    return points;
  };

  try {
    await playFrames(
      video,
      (time) => {
        sampled++;
        while (mi < motions.length - 1 && motions[mi + 1].time <= time) mi++;
        const m = motions[mi];
        const attempts: [PoseFrame["source"], Crop | null][] = [];
        if (last && time - last.time < 0.6) {
          const c = cropFromPose(last, W, H);
          if (c) attempts.push(["track", c]);
        }
        if (m) {
          const c = cropFromMotion(m.focusX, m.fgYMedian, o.grayWidth, W, H);
          if (c) attempts.push(["motion", c]);
        }
        attempts.push(["full", null]);
        for (const [source, crop] of attempts.slice(0, 2)) {
          const points = run(crop);
          if (points) {
            last = { time, points, source };
            frames.push(last);
            return;
          }
        }
      },
      { fps: o.fps, adaptive: true, onProgress: o.onProgress, signal: o.signal },
    );
  } finally {
    landmarker.close();
  }
  return { keypoints: KEYPOINTS, videoWidth: W, videoHeight: H, frames, sampled };
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
