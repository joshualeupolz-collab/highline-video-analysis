/**
 * Browser pose tracking with MediaPipe Pose Landmarker. Runs the model on a square crop around the
 * athlete (from the previous pose, else from the motion analysis, else the whole frame), which
 * finds people much smaller than the model would on the full frame.
 */
import type { FrameMotion } from "../types";
import { playFrames } from "../videoFrames";
import { poseFeatures } from "./features";
import { rayScores, trackLine, type GrayImage, type LineObservation } from "./line";
import { cropFromMotion, cropFromPose, fromCrop, squareCrop, type Crop } from "./roi";
import { trackPoses, type PoseCandidate, type PoseSample } from "./track";
import { KEYPOINTS, MEDIAPIPE_INDEX, type PoseFrame, type PoseTrack } from "./types";

export type PoseModel = "lite" | "full" | "heavy";

export interface PoseOptions {
  /** Pose samples per second of video in calm phases. */
  fps: number;
  /**
   * Samples per second while the body turns fast, moves fast or is hard to recognise: then every
   * frame (or `denseFps`) is analysed for at least `denseHold` seconds.
   */
  denseFps: number;
  denseHold: number;
  /** Turn rate (degrees per second) and centre speed (torso lengths per second) that switch to dense sampling. */
  denseTurn: number;
  denseSpeed: number;
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
  /** Fastest turn (degrees per second) assumed when predicting where the body will be. */
  turnRate: number;
  /** "GPU" (falls back to CPU if unavailable) or "CPU". GPU is faster on phones; without a real GPU it is very slow. */
  delegate: "GPU" | "CPU";
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const VERSION = "1.0.1";

export const defaultPoseOptions: PoseOptions = {
  fps: 10,
  denseFps: 30,
  denseHold: 0.4,
  denseTurn: 200,
  denseSpeed: 6,
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
  turnRate: 1000,
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
  // Warm up before playing: the first inference (GPU shader compilation) can take seconds
  {
    const warm = document.createElement("canvas");
    warm.width = o.inputSize;
    warm.height = o.inputSize;
    const wctx = warm.getContext("2d")!;
    if (video.readyState >= 2) wctx.drawImage(video, 0, 0, o.inputSize, o.inputSize);
    landmarker.detect(warm);
    landmarker.detect(warm);
  }
  const W = video.videoWidth;
  const H = video.videoHeight;
  const canvas = document.createElement("canvas");
  canvas.width = o.inputSize;
  canvas.height = o.inputSize;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const samples: PoseSample[] = [];
  const lineObs: LineObservation[] = [];
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

  // Gray copy of the frame for the line search (480 px wide)
  const lineW = Math.min(480, W);
  const lineH = Math.round((H * lineW) / W);
  const lineCanvas = document.createElement("canvas");
  lineCanvas.width = lineW;
  lineCanvas.height = lineH;
  const lineCtx = lineCanvas.getContext("2d", { willReadFrequently: true })!;
  const observeLine = (time: number, points: number[]) => {
    const f = poseFeatures({ time, points, source: "track" });
    if (!Number.isFinite(f.scale)) return;
    lineCtx.drawImage(video, 0, 0, lineW, lineH);
    const rgba = lineCtx.getImageData(0, 0, lineW, lineH).data;
    const gray: GrayImage = { data: new Float32Array(lineW * lineH), width: lineW, height: lineH };
    for (let i = 0, j = 0; i < gray.data.length; i++, j += 4) {
      gray.data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    const mean = (names: (typeof KEYPOINTS)[number][]) => {
      const v = names.map((n) => KEYPOINTS.indexOf(n) * 3).filter((i) => points[i + 2] >= 0.3);
      return v.length
        ? ([v.reduce((a, i) => a + points[i], 0) / v.length, v.reduce((a, i) => a + points[i + 1], 0) / v.length] as [number, number])
        : null;
    };
    const contacts: LineObservation["contacts"] = [];
    const feet = mean(["leftAnkle", "rightAnkle", "leftHeel", "rightHeel", "leftToe", "rightToe"]);
    const hands = mean(["leftWrist", "rightWrist"]);
    // Directions that cannot be the line: along the athlete's own limbs from the contact point, and
    // (nearly) vertical, where the leash or a rope to a backup line hangs
    const masked = (point: [number, number], scores: number[], towards: [number, number][]) =>
      scores.map((v, i) => {
        const a = (i * 360) / scores.length;
        const vertical = Math.min(Math.abs(a - 90), Math.abs(a - 270)) < 10;
        const alongBody = towards.some(([x, y]) => {
          const b = (Math.atan2(y - point[1], x - point[0]) * 180) / Math.PI;
          const d = Math.abs(((a - b) % 360) + 360) % 360;
          return Math.min(d, 360 - d) < 20;
        });
        return vertical || alongBody ? 0 : round(v, 2);
      });
    const at = (names: (typeof KEYPOINTS)[number][]) =>
      names.map((n) => mean([n])).filter((p): p is [number, number] => !!p);
    if (feet) contacts.push({ via: "feet", point: feet, scores: masked(feet, rayScores(gray, feet, f.scale), at(["leftKnee", "rightKnee", "leftHip", "rightHip"])) });
    // Hands only when they can hold the line: body not upright (hanging, upside down), or both
    // hands above the head (hanging from the line or reaching for it)
    const nose = mean(["nose"]);
    const lw = mean(["leftWrist"]);
    const rw = mean(["rightWrist"]);
    const handsUp = !!(nose && lw && rw && lw[1] < nose[1] && rw[1] < nose[1]);
    if (hands && (!(Math.abs(f.tilt) < 60) || handsUp)) contacts.push({ via: "hands", point: hands, scores: masked(hands, rayScores(gray, hands, f.scale), at(["leftElbow", "rightElbow", "leftShoulder", "rightShoulder"])) });
    lineObs.push({ time, torso: f.scale, contacts });
  };

  // Online state: the last two picked poses give speed and turn rate for the prediction
  let last: { time: number; points: number[] } | null = null;
  let velocity = { x: 0, y: 0, turn: 0 };
  let searchTurn = 0;
  let denseUntil = -1;
  let currentTime = 0;
  let dense = 0;

  try {
    await playFrames(
      video,
      (time) => {
        currentTime = time;
        if (time < denseUntil) dense++;
        while (mi < motions.length - 1 && motions[mi + 1].time <= time) mi++;
        const m = motions[mi];
        const recent = last && time - last.time < 0.6 ? last : null;
        const crops: [PoseFrame["source"], Crop | null][] = [];
        if (recent) {
          // Predict: the body keeps moving and turning as it did
          const dt = time - recent.time;
          const box = cropFromPose({ time: recent.time, points: recent.points, source: "track" }, W, H);
          if (box) {
            const turn = Math.max(-o.turnRate, Math.min(o.turnRate, velocity.turn));
            const predicted = squareCrop(box.cx + velocity.x * W * dt, box.cy + velocity.y * W * dt, box.size, W, H, box.angle + turn * dt);
            crops.push(["track", predicted]);
            // Second look: upright crop (the model knows upright people best), or a wider one
            crops.push(["track", Math.abs(predicted.angle) > 25 ? { ...predicted, angle: 0 } : { ...predicted, size: Math.min(predicted.size * 1.5, Math.min(W, H)) }]);
          }
        } else {
          // Not tracking: search around the motion focus with a few crop sizes (a small athlete in a
          // portrait frame is too small for the model on the full frame), then the full frame.
          // The sizes rotate from sample to sample so every size gets its turn.
          if (m) {
            const sizes = [0.45, 0.3, 0.7];
            for (let j = 0; j < 2; j++) {
              const c = cropFromMotion(m.focusX, m.fgYMedian, o.grayWidth, W, H, sizes[(searchTurn + j) % sizes.length]);
              if (c) crops.push(["motion", c]);
            }
            searchTurn++;
          }
          crops.push(["full", null]);
        }
        // Second look only when the first does not fit the prediction (saves about half the time)
        const fitsPrediction = (points: number[]) => {
          if (!recent) return meanVis(points) >= 0.6;
          const dt = time - recent.time;
          const a = poseFeatures({ time: recent.time, points: recent.points, source: "track" });
          const b = poseFeatures({ time, points, source: "track" });
          const turn = Math.max(-o.turnRate, Math.min(o.turnRate, velocity.turn));
          const expected = a.tilt + turn * dt;
          const dTilt = Math.abs(((b.tilt - expected + 540) % 360) - 180);
          const ca = centreOf(recent.points);
          const cb = centreOf(points);
          const moved = ca && cb ? Math.hypot(cb[0] - (ca[0] + velocity.x * dt), cb[1] - (ca[1] + velocity.y * dt)) : Infinity;
          return meanVis(points) >= 0.5 && dTilt < 40 && moved < 0.5 * (a.scale || 0.1);
        };
        const candidates: PoseCandidate[] = [];
        for (const [source, crop] of crops) {
          const points = run(crop);
          if (points) candidates.push({ points, source });
          if (points && fitsPrediction(points)) break;
        }
        samples.push({ time, candidates });
        const unclear = !candidates.length || !fitsPrediction(candidates[candidates.length - 1].points) || candidates.length > 1;
        if (unclear && recent) denseUntil = time + o.denseHold;
        if (!candidates.length) return;

        // Online pick (only to steer the next crop): closest to the predicted pose
        let pick = candidates[0];
        if (recent) {
          const dt = time - recent.time;
          const dist = (pts: number[]) => {
            let s = 0;
            let n = 0;
            for (let k = 0; k < KEYPOINTS.length; k++) {
              if (pts[k * 3 + 2] < 0.3 || recent.points[k * 3 + 2] < 0.3) continue;
              s += Math.hypot(pts[k * 3] - (recent.points[k * 3] + velocity.x * dt), pts[k * 3 + 1] - (recent.points[k * 3 + 1] + velocity.y * dt));
              n++;
            }
            return n ? s / n : Infinity;
          };
          pick = candidates.reduce((a, b) => (dist(b.points) < dist(a.points) ? b : a));
          const pa = poseFeatures({ time: recent.time, points: recent.points, source: "track" });
          const pb = poseFeatures({ time, points: pick.points, source: "track" });
          const ca = centreOf(recent.points);
          const cb = centreOf(pick.points);
          if (ca && cb && dt > 0) {
            const k = 0.5; // smoothing of the velocity estimate
            velocity.x = velocity.x * (1 - k) + ((cb[0] - ca[0]) / dt) * k;
            velocity.y = velocity.y * (1 - k) + ((cb[1] - ca[1]) / dt) * k;
          }
          if (Number.isFinite(pa.tilt) && Number.isFinite(pb.tilt) && dt > 0) {
            const d = ((pb.tilt - pa.tilt + 540) % 360) - 180;
            velocity.turn = velocity.turn * 0.5 + (d / dt) * 0.5;
          }
        } else {
          pick = candidates.reduce((a, b) => (meanVis(b.points) > meanVis(a.points) ? b : a));
          velocity = { x: 0, y: 0, turn: 0 };
        }
        last = { time, points: pick.points };
        const torsoLen = poseFeatures({ time, points: pick.points, source: "track" }).scale || 0.1;
        if (Math.abs(velocity.turn) > o.denseTurn || Math.hypot(velocity.x, velocity.y) / torsoLen > o.denseSpeed) {
          denseUntil = time + o.denseHold;
        }
        if (o.line) observeLine(time, pick.points);
      },
      {
        fps: o.fps,
        pauseWhileWorking: true,
        nextStep: () => 1 / (currentTime < denseUntil ? o.denseFps : o.fps),
        onProgress: o.onProgress,
        signal: o.signal,
      },
    );
  } finally {
    landmarker.close();
  }

  // Offline: best path through all candidates, outliers out, gaps filled, smoothed
  const frames = trackPoses(samples);
  const found = new Set(samples.filter((x) => x.candidates.length).map((x) => x.time));
  const missed = samples.filter((x) => !found.has(x.time)).map((x) => round(x.time, 3));
  if (o.line) {
    const lines = trackLine(lineObs);
    const byTime = new Map(lineObs.map((x, i) => [x.time, lines[i]]));
    for (const f of frames) {
      const l = byTime.get(f.time);
      if (l) f.line = l;
    }
  }
  const sampled = samples.length;
  return { keypoints: KEYPOINTS, videoWidth: W, videoHeight: H, frames, sampled, missed, dense };

}

function meanVis(points: number[]): number {
  let s = 0;
  for (let k = 0; k < KEYPOINTS.length; k++) s += points[k * 3 + 2];
  return s / KEYPOINTS.length;
}

function centreOf(points: number[]): [number, number] | null {
  const ids = [KEYPOINTS.indexOf("leftHip"), KEYPOINTS.indexOf("rightHip"), KEYPOINTS.indexOf("leftShoulder"), KEYPOINTS.indexOf("rightShoulder")];
  const v = ids.filter((i) => points[i * 3 + 2] >= 0.3);
  if (!v.length) return null;
  return [v.reduce((a, i) => a + points[i * 3], 0) / v.length, v.reduce((a, i) => a + points[i * 3 + 1], 0) / v.length];
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
