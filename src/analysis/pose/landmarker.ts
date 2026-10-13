/**
 * Browser pose tracking with MediaPipe Pose Landmarker. Runs the model on a square crop around the
 * athlete (from the previous pose, else from the motion analysis, else the whole frame), which
 * finds people much smaller than the model would on the full frame.
 */
import type { FrameMotion } from "../types";
import { playFrames } from "../videoFrames";
import { poseFeatures } from "./features";
import { detectLine, type GrayImage, type LineEstimate } from "./line";
import { angleDiff, cropFromMotion, cropFromPose, fromCrop, type Crop } from "./roi";
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
  /** Also look for the tensioned line (experimental). */
  line: boolean;
  /**
   * Largest plausible torso turn between two samples: `turnRate` degrees per second times the time
   * between them, plus `turnSlack` degrees. Faster "turns" are the model flipping the skeleton.
   */
  turnRate: number;
  turnSlack: number;
  /** "GPU" (falls back to CPU if unavailable) or "CPU". GPU is faster on phones; without a real GPU it is very slow. */
  delegate: "GPU" | "CPU";
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const VERSION = "1.0.1";

export const defaultPoseOptions: PoseOptions = {
  fps: 15,
  model: "full",
  wasmBases: ["./mediapipe", `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`],
  modelUrls: (m) => [
    `./mediapipe/pose_landmarker_${m}.task`,
    // Same model as base64 in JSON ({ "base64": "..." }) for hosts that do not serve .task files
    `./mediapipe/pose_landmarker_${m}.json`,
    `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`,
  ],
  inputSize: 256,
  grayWidth: 160,
  minConfidence: 0.3,
  delegate: "GPU",
  line: true,
  turnRate: 400,
  turnSlack: 40,
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
  const model = modelUrl.endsWith(".json")
    ? { modelAssetBuffer: base64ToBytes(((await (await fetch(modelUrl)).json()) as { base64: string }).base64) }
    : { modelAssetPath: modelUrl };
  const make = (delegate: "GPU" | "CPU") =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { ...model, delegate },
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
  const missed: number[] = [];
  let sampled = 0;
  let last: PoseFrame | null = null;
  let mi = 0;

  const run = (crop: Crop | null): number[] | null => {
    let res;
    if (crop) {
      const S = o.inputSize;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, S, S);
      // Crop pixels → canvas: turn by -angle around the crop centre and scale to S
      ctx.translate(S / 2, S / 2);
      ctx.scale(S / crop.size, S / crop.size);
      ctx.rotate((-crop.angle * Math.PI) / 180);
      ctx.translate(-crop.cx, -crop.cy);
      ctx.drawImage(video, 0, 0, W, H);
      res = landmarker.detect(canvas);
    } else res = landmarker.detect(video);
    const lm = res.landmarks[0];
    if (!lm) return null;
    const points: number[] = [];
    for (const k of KEYPOINTS) {
      const p = lm[MEDIAPIPE_INDEX[k]];
      const [px, py] = crop ? fromCrop(crop, p.x, p.y) : [p.x * W, p.y * H];
      points.push(round(px / W), round(py / W), round(p.visibility ?? 1, 2));
    }
    return points;
  };
  const tiltOf = (points: number[], time: number) => poseFeatures({ time, points, source: "track" }).tilt;

  // Gray copy of the frame for the line search (480 px wide)
  const lineW = Math.min(480, W);
  const lineH = Math.round((H * lineW) / W);
  const lineCanvas = document.createElement("canvas");
  lineCanvas.width = lineW;
  lineCanvas.height = lineH;
  const lineCtx = lineCanvas.getContext("2d", { willReadFrequently: true })!;
  let lastLine: { time: number; line: LineEstimate } | null = null;
  const findLine = (frame: PoseFrame): LineEstimate | null => {
    const f = poseFeatures(frame);
    if (!Number.isFinite(f.scale)) return null;
    lineCtx.drawImage(video, 0, 0, lineW, lineH);
    const rgba = lineCtx.getImageData(0, 0, lineW, lineH).data;
    const gray: GrayImage = { data: new Float32Array(lineW * lineH), width: lineW, height: lineH };
    for (let i = 0, j = 0; i < gray.data.length; i++, j += 4) {
      gray.data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    const pts = (names: (typeof KEYPOINTS)[number][]) => {
      const v = names
        .map((n) => KEYPOINTS.indexOf(n) * 3)
        .filter((i) => frame.points[i + 2] >= 0.3)
        .map((i) => [frame.points[i], frame.points[i + 1]] as [number, number]);
      return v.length ? ([v.reduce((a, p) => a + p[0], 0) / v.length, v.reduce((a, p) => a + p[1], 0) / v.length] as [number, number]) : null;
    };
    const candidates: { via: LineEstimate["via"]; point: [number, number] }[] = [];
    const feet = pts(["leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftToe", "rightToe"]);
    const hands = pts(["leftWrist", "rightWrist"]);
    if (feet && Math.abs(f.tilt) < 70) candidates.push({ via: "feet", point: feet });
    if (hands) candidates.push({ via: "hands", point: hands });
    const prev = lastLine && frame.time - lastLine.time < 0.4 ? lastLine.line : null;
    const line = detectLine(gray, candidates, f.scale, prev);
    if (line) lastLine = { time: frame.time, line };
    return line;
  };

  try {
    await playFrames(
      video,
      (time) => {
        sampled++;
        while (mi < motions.length - 1 && motions[mi + 1].time <= time) mi++;
        const m = motions[mi];
        const recent = last && time - last.time < 0.6 ? last : null;
        const attempts: [PoseFrame["source"], Crop | null][] = [];
        if (recent) {
          const c = cropFromPose(recent, W, H);
          if (c) attempts.push(["track", c]);
        }
        if (m) {
          const c = cropFromMotion(m.focusX, m.fgYMedian, o.grayWidth, W, H);
          if (c) attempts.push(["motion", c]);
        }
        attempts.push(["full", null]);

        // The body cannot turn faster than `turnRate` between samples: such a jump is
        // the model flipping the skeleton (head where the feet are). Then try a wider crop and the
        // other sources, keep the result closest to the previous pose, or none.
        const prevTilt = recent ? tiltOf(recent.points, recent.time) : NaN;
        const maxTurn = recent ? o.turnRate * (time - recent.time) + o.turnSlack : Infinity;
        const plausible = (points: number[]) =>
          !Number.isFinite(prevTilt) || !(angleDiff(tiltOf(points, time), prevTilt) > maxTurn);
        let best: { points: number[]; source: PoseFrame["source"]; diff: number } | null = null;
        let tries = 0;
        const candidates: [PoseFrame["source"], Crop | null][] = [...attempts];
        if (recent) {
          const wide = cropFromPose(recent, W, H, 2.6);
          if (wide) candidates.splice(1, 0, ["track", wide]);
        }
        for (const [source, crop] of candidates) {
          if (tries >= (Number.isFinite(prevTilt) ? 3 : 2)) break;
          tries++;
          const points = run(crop);
          if (!points) continue;
          if (plausible(points)) {
            best = { points, source, diff: 0 };
            break;
          }
          const diff = angleDiff(tiltOf(points, time), prevTilt);
          if (!best || diff < best.diff) best = { points, source, diff };
        }
        if (best && best.diff <= maxTurn) {
          last = { time, points: best.points, source: best.source };
          if (o.line) {
            const line = findLine(last);
            if (line) last.line = line;
          }
          frames.push(last);
        } else missed.push(round(time, 3));
      },
      { fps: o.fps, adaptive: true, onProgress: o.onProgress, signal: o.signal },
    );
  } finally {
    landmarker.close();
  }
  return { keypoints: KEYPOINTS, videoWidth: W, videoHeight: H, frames, sampled, missed };

}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
