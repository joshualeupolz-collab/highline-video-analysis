import { describe, expect, it } from "vitest";
import { poseFeatures } from "../src/analysis/pose/features";
import { interpolatePose, swapLeftRight, trackPoses, type PoseSample } from "../src/analysis/pose/track";
import { KEYPOINTS, type PoseFrame } from "../src/analysis/pose/types";

type Pt = [number, number];
const REL: Record<string, Pt> = {
  nose: [0, -0.2],
  leftShoulder: [-0.03, -0.15],
  rightShoulder: [0.03, -0.15],
  leftElbow: [-0.06, -0.08],
  rightElbow: [0.06, -0.08],
  leftWrist: [-0.07, -0.02],
  rightWrist: [0.07, -0.02],
  leftHip: [-0.02, 0],
  rightHip: [0.02, 0],
  leftKnee: [-0.02, 0.1],
  rightKnee: [0.02, 0.1],
  leftAnkle: [-0.02, 0.2],
  rightAnkle: [0.02, 0.2],
  leftHeel: [-0.03, 0.21],
  rightHeel: [0.01, 0.21],
  leftToe: [0, 0.21],
  rightToe: [0.04, 0.21],
};

function pose(x: number, y: number, rot = 0): number[] {
  const r = (rot * Math.PI) / 180;
  return KEYPOINTS.flatMap((k) => {
    const [dx, dy] = REL[k];
    return [x + dx * Math.cos(r) - dy * Math.sin(r), y + dx * Math.sin(r) + dy * Math.cos(r), 0.9];
  });
}

const tilt = (points: number[]) => poseFeatures({ time: 0, points, source: "track" } as PoseFrame).tilt;
const wrist = (points: number[]) => points[KEYPOINTS.indexOf("leftWrist") * 3];

describe("trackPoses", () => {
  it("ignores a single flipped skeleton between upright ones", () => {
    const samples: PoseSample[] = [];
    for (let i = 0; i < 20; i++) {
      const t = i / 15;
      const flipped = i === 10;
      samples.push({ time: t, candidates: [{ points: pose(0.5, 0.5 + 0.01 * i, flipped ? 180 : 0), source: "track" }] });
    }
    const out = trackPoses(samples);
    const at10 = out.find((f) => Math.abs(f.time - 10 / 15) < 1e-6)!;
    expect(Math.abs(tilt(at10.points))).toBeLessThan(20);
    expect(at10.source).toBe("interpolated");
  });

  it("prefers the candidate that continues the motion", () => {
    const samples: PoseSample[] = [];
    for (let i = 0; i < 15; i++) {
      const t = i / 15;
      const good = pose(0.3 + 0.01 * i, 0.5);
      const bad = pose(0.8, 0.2, 90);
      samples.push({ time: t, candidates: i === 7 ? [{ points: bad, source: "track" }, { points: good, source: "track" }] : [{ points: good, source: "track" }] });
    }
    const out = trackPoses(samples);
    const at7 = out.find((f) => Math.abs(f.time - 7 / 15) < 1e-6)!;
    expect(at7.points[KEYPOINTS.indexOf("leftHip") * 3]).toBeCloseTo(0.37 - 0.02, 2);
  });

  it("undoes a left/right swap", () => {
    const samples: PoseSample[] = [];
    for (let i = 0; i < 12; i++) {
      const p = pose(0.5, 0.5);
      samples.push({ time: i / 15, candidates: [{ points: i === 6 ? swapLeftRight(p) : p, source: "track" }] });
    }
    const out = trackPoses(samples);
    expect(wrist(out[6].points)).toBeCloseTo(wrist(pose(0.5, 0.5)), 3);
  });

  it("fills a gap in a rotation by turning the body on", () => {
    const samples: PoseSample[] = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 15;
      samples.push({ time: t, candidates: i >= 3 && i <= 5 ? [] : [{ points: pose(0.5, 0.5, i * 20), source: "track" }] });
    }
    const out = trackPoses(samples);
    expect(out).toHaveLength(9);
    expect(tilt(out[4].points)).toBeGreaterThan(65);
    expect(tilt(out[4].points)).toBeLessThan(95);
  });
});

describe("interpolatePose", () => {
  it("keeps the body shape while turning", () => {
    const mid = interpolatePose(pose(0.5, 0.5, 0), pose(0.5, 0.5, 120), 0.5);
    expect(tilt(mid)).toBeCloseTo(60, 0);
    const torso = (p: number[]) => {
      const f = poseFeatures({ time: 0, points: p, source: "track" } as PoseFrame);
      return f.scale;
    };
    expect(torso(mid)).toBeCloseTo(torso(pose(0.5, 0.5)), 3);
  });
});
