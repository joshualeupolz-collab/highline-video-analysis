import { describe, expect, it } from "vitest";
import { MotionTracker } from "../src/analysis/motion";
import { PhaseCorrelator } from "../src/analysis/phaseCorrelation";
import type { GrayFrame } from "../src/analysis/types";

/** Seeded random texture; `texture(w, h, ox, oy)` is the same scene with its content moved by (ox, oy). */
const SCENE = 400;
const scene = (() => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;
  const raw = Float32Array.from({ length: SCENE * SCENE }, rnd);
  // light 3x3 blur so it looks a bit like a real image
  const out = new Float32Array(raw.length);
  for (let y = 1; y < SCENE - 1; y++)
    for (let x = 1; x < SCENE - 1; x++) {
      let s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += raw[(y + j) * SCENE + x + i];
      out[y * SCENE + x] = s / 9;
    }
  return out;
})();

function texture(w: number, h: number, ox: number, oy: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = scene[(y + 100 - oy) * SCENE + (x + 100 - ox)];
  return out;
}

describe("PhaseCorrelator", () => {
  it("finds shifts with the right sign", () => {
    const pc = new PhaseCorrelator(64, 64);
    const a = pc.spectrum(texture(64, 64, 0, 0));
    for (const [dx, dy] of [
      [3, -2],
      [-5, 4],
      [0, 7],
    ]) {
      const b = pc.spectrum(texture(64, 64, dx, dy));
      const r = pc.correlate(a, b);
      expect(Math.abs(r.dx - dx)).toBeLessThan(0.35);
      expect(Math.abs(r.dy - dy)).toBeLessThan(0.35);
    }
  });
});

describe("MotionTracker", () => {
  const frame = (ox: number, oy: number, time: number, blob?: [number, number]): GrayFrame => {
    const data = texture(160, 120, ox, oy);
    if (blob) {
      for (let y = blob[1] - 6; y < blob[1] + 6; y++)
        for (let x = blob[0] - 6; x < blob[0] + 6; x++) data[y * 160 + x] = 255;
    }
    return { data, width: 160, height: 120, time };
  };

  it("reports camera shift in gray-frame pixels and little residual for a pure pan", () => {
    const t = new MotionTracker();
    t.push(frame(0, 0, 0));
    const m = t.push(frame(2, -3, 1 / 15))!;
    expect(m.dx).toBeCloseTo(2, 0);
    expect(m.dy).toBeCloseTo(-3, 0);
    expect(m.residual).toBeLessThan(1);
    expect(m.cut).toBe(false);
  });

  it("locates a moving foreground object", () => {
    const t = new MotionTracker();
    t.push(frame(0, 0, 0, [80, 40]));
    const m = t.push(frame(0, 0, 1 / 15, [80, 70]))!;
    expect(m.residual).toBeGreaterThan(0.5);
    expect(m.fgX).toBeGreaterThan(70);
    expect(m.fgX).toBeLessThan(90);
    expect(m.fgY).toBeGreaterThan(35);
    expect(m.fgY).toBeLessThan(75);
  });
});
