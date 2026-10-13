import { describe, expect, it } from "vitest";
import { detectCutPoints } from "../src/analysis/detect";
import { evaluateCutPoints } from "../src/analysis/evaluate";
import type { FrameMotion } from "../src/analysis/types";

/**
 * Synthetic bouncing athlete followed by a camera: the athlete's height follows a periodic curve with
 * sharp-ish bottoms at known times; the camera follows most of it, the rest shows up as fgY.
 */
function synthetic(period: number, duration: number, fps = 15, follow = 0.8, cutAt?: number): {
  motions: FrameMotion[];
  bdc: number[];
} {
  const phase0 = 0.7;
  const lowness = (t: number) => Math.cos((2 * Math.PI * (t - phase0)) / period) * 100; // max at BDC
  const motions: FrameMotion[] = [];
  let prevCam = 0;
  for (let i = 1; i <= duration * fps; i++) {
    const t = i / fps;
    const cam = follow * lowness(t);
    motions.push({
      time: t,
      dx: 0,
      dy: -(cam - prevCam), // camera tilts down → content moves up
      peak: 0.3,
      residual: 2 + Math.abs(Math.sin((2 * Math.PI * (t - phase0)) / period)) * 3,
      rawDiff: 5,
      fgX: 80,
      fgY: 100 + (1 - follow) * lowness(t),
      cut: cutAt !== undefined && Math.abs(t - cutAt) < 0.5 / fps,
    });
    prevCam = cam;
  }
  const bdc: number[] = [];
  for (let t = phase0; t < duration; t += period) bdc.push(t);
  return { motions, bdc };
}

describe("detectCutPoints", () => {
  it("finds every bottom of a clean periodic bounce", () => {
    const { motions, bdc } = synthetic(3.3, 40);
    const r = detectCutPoints(motions, 40);
    expect(r.period).toBeGreaterThan(3.1);
    expect(r.period).toBeLessThan(3.5);
    const ev = evaluateCutPoints(bdc, r.cutPoints.map((c) => c.time), 0.3);
    expect(ev.recall).toBeGreaterThanOrEqual(0.9);
    expect(ev.precision).toBeGreaterThanOrEqual(0.9);
  });

  it("works for a fixed camera (all motion in fgY)", () => {
    const { motions, bdc } = synthetic(3.0, 30, 15, 0);
    const r = detectCutPoints(motions, 30);
    const ev = evaluateCutPoints(bdc, r.cutPoints.map((c) => c.time), 0.3);
    expect(ev.recall).toBeGreaterThanOrEqual(0.9);
  });

  it("reports hard cuts and does not mix shots", () => {
    const { motions } = synthetic(3.3, 30, 15, 0.8, 15);
    const r = detectCutPoints(motions, 30);
    expect(r.signals.cuts).toHaveLength(1);
    expect(r.signals.cuts[0]).toBeCloseTo(15, 1);
  });
});
