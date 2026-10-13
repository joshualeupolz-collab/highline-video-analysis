import { describe, expect, it } from "vitest";
import { cameraAt, cameraPath } from "../src/analysis/pose/camera";
import { angleAt, poseFeatures } from "../src/analysis/pose/features";
import { bounceProfiles, unwrappedRotation } from "../src/analysis/pose/profile";
import { refineWithPose } from "../src/analysis/pose/refine";
import { cropFromPose, squareCrop } from "../src/analysis/pose/roi";
import { KEYPOINTS, type PoseFrame, type PoseTrack } from "../src/analysis/pose/types";
import type { FrameMotion } from "../src/analysis/types";

type Pt = [number, number];

/** A stick figure: hips at (0.5, y), standing; `knee` bends both knees, `rot` rotates the whole body (degrees). */
function figure(time: number, opts: { y?: number; knee?: number; rot?: number; armsUp?: boolean } = {}): PoseFrame {
  const y = opts.y ?? 0.5;
  const bend = ((180 - (opts.knee ?? 180)) * Math.PI) / 180;
  const rel: Record<string, Pt> = {
    nose: [0, -0.2],
    leftShoulder: [-0.03, -0.15],
    rightShoulder: [0.03, -0.15],
    leftElbow: [-0.06, opts.armsUp ? -0.22 : -0.08],
    rightElbow: [0.06, opts.armsUp ? -0.22 : -0.08],
    leftWrist: [-0.07, opts.armsUp ? -0.3 : -0.02],
    rightWrist: [0.07, opts.armsUp ? -0.3 : -0.02],
    leftHip: [-0.02, 0],
    rightHip: [0.02, 0],
    leftKnee: [-0.02, 0.1],
    rightKnee: [0.02, 0.1],
    // Shank turned by the knee bend
    leftAnkle: [-0.02 + 0.1 * Math.sin(bend), 0.1 + 0.1 * Math.cos(bend)],
    rightAnkle: [0.02 + 0.1 * Math.sin(bend), 0.1 + 0.1 * Math.cos(bend)],
    leftHeel: [-0.03 + 0.1 * Math.sin(bend), 0.11 + 0.1 * Math.cos(bend)],
    rightHeel: [0.01 + 0.1 * Math.sin(bend), 0.11 + 0.1 * Math.cos(bend)],
    leftToe: [0 + 0.1 * Math.sin(bend), 0.11 + 0.1 * Math.cos(bend)],
    rightToe: [0.04 + 0.1 * Math.sin(bend), 0.11 + 0.1 * Math.cos(bend)],
  };
  const r = ((opts.rot ?? 0) * Math.PI) / 180;
  const points: number[] = [];
  for (const k of KEYPOINTS) {
    const [dx, dy] = rel[k];
    points.push(0.5 + dx * Math.cos(r) - dy * Math.sin(r), y + dx * Math.sin(r) + dy * Math.cos(r), 0.9);
  }
  return { time, points, source: "track" };
}

const track = (frames: PoseFrame[]): PoseTrack => ({
  keypoints: KEYPOINTS,
  videoWidth: 1000,
  videoHeight: 1000,
  frames,
  sampled: frames.length,
});

describe("pose features", () => {
  it("measures joint angles", () => {
    expect(angleAt([0, 0], [1, 0], [2, 0])).toBeCloseTo(180);
    expect(angleAt([0, 1], [0, 0], [1, 0])).toBeCloseTo(90);
  });

  it("reads straight and bent knees, tilt and uprightness", () => {
    const straight = poseFeatures(figure(0));
    expect(straight.knee).toBeCloseTo(180, 0);
    expect(straight.tilt).toBeCloseTo(0, 0);
    expect(straight.upright).toBe(true);
    expect(poseFeatures(figure(0, { knee: 100 })).knee).toBeCloseTo(100, 0);
    const flipped = poseFeatures(figure(0, { rot: 180 }));
    expect(Math.abs(flipped.tilt)).toBeCloseTo(180, 0);
    expect(flipped.upright).toBe(false);
  });
});

describe("crops", () => {
  it("keeps crops inside the frame", () => {
    const c = squareCrop(10, 10, 200, 1000, 500);
    expect(c).toEqual({ x: 0, y: 0, size: 200 });
    expect(squareCrop(500, 250, 2000, 1000, 500).size).toBe(500);
  });

  it("crops around a pose with padding", () => {
    const c = cropFromPose(figure(0), 1000, 1000)!;
    // The figure spans about 0.14 x 0.31 frame widths
    expect(c.size).toBeGreaterThan(0.31 * 1000);
    expect(c.x).toBeLessThan(500);
    expect(c.x + c.size).toBeGreaterThan(500);
  });
});

describe("camera path", () => {
  it("accumulates vertical shift and restarts at cuts", () => {
    const m = (time: number, dy: number, cut = false) => ({ time, dy, cut }) as FrameMotion;
    const path = cameraPath([m(0.1, 16), m(0.2, 16), m(0.3, 50, true), m(0.4, 16)], 160);
    expect(path.camY).toEqual([0.1, 0.2, 0, 0.1]);
    expect(path.shot).toEqual([0, 0, 1, 1]);
    expect(cameraAt(path, 0.15).camY).toBeCloseTo(0.15);
    expect(cameraAt(path, 0.35).shot).toBe(1);
  });
});

describe("refineWithPose", () => {
  const path = cameraPath([], 160);
  // Knees bent until 2.0 s, straight afterwards
  const frames = Array.from({ length: 40 }, (_, i) => figure(i * 0.1, { knee: i * 0.1 < 2.0 ? 120 : 178 }));

  it("blends motion and knee time by default", () => {
    const [c] = refineWithPose([{ time: 2.3, confidence: 1 }], track(frames), path);
    expect(c.method).toBe("pose");
    expect(c.motionTime).toBe(2.3);
    expect(c.time).toBeGreaterThan(2.1);
    expect(c.time).toBeLessThan(2.2);
  });

  it("keeps the motion time in off mode and reports the knee angle", () => {
    const [c] = refineWithPose([{ time: 2.2, confidence: 1 }], track(frames), path, { mode: "off" });
    expect(c.time).toBe(2.2);
    expect(c.method).toBe("motion");
    expect(c.knee).toBeGreaterThan(170);
  });

  it("moves to the moment the knees straighten in knee mode", () => {
    const [c] = refineWithPose([{ time: 2.3, confidence: 1 }], track(frames), path, { mode: "knee" });
    expect(c.method).toBe("pose");
    expect(c.time).toBeGreaterThan(1.9);
    expect(c.time).toBeLessThan(2.05);
  });
});

describe("bounce profiles", () => {
  it("unwraps rotation across ±180°", () => {
    expect(unwrappedRotation([0, 90, 170, -170, -90, 0])).toBeCloseTo(360);
    expect(unwrappedRotation([0, -60, -120, 180])).toBeCloseTo(-180);
  });

  it("summarises tuck, flip and arms per bounce", () => {
    const frames: PoseFrame[] = [];
    for (let i = 0; i <= 30; i++) {
      const t = i * 0.1;
      frames.push(figure(t, { rot: (t / 3) * 360, knee: t > 1 && t < 2 ? 60 : 175, armsUp: t < 0.5 }));
    }
    const [p] = bounceProfiles(track(frames), [0, 3], 10);
    expect(p.rotation).toBeGreaterThan(300);
    expect(p.kneeMin).toBeLessThan(70);
    expect(p.kneeMinAt).toBeGreaterThan(1);
    expect(p.tiltMax).toBeGreaterThan(160);
    expect(p.invertedTime).toBeGreaterThan(0.5);
    expect(p.armsUp).toBeGreaterThan(0.1);
    expect(p.coverage).toBeCloseTo(1, 1);
  });
});
