import { describe, expect, it } from "vitest";
import { detectLine, trackLine, type GrayImage } from "../src/analysis/pose/line";

/** Noisy gray image with a dark 2 px line kinked at (cx, cy): one half at angle a1, the other at a2 (degrees). */
function image(cx: number, cy: number, a1: number, a2: number): GrayImage {
  const w = 480;
  const h = 640;
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 30;
  const data = Float32Array.from({ length: w * h }, () => 150 + rnd());
  for (const a of [a1, a2]) {
    const ux = Math.cos((a * Math.PI) / 180);
    const uy = Math.sin((a * Math.PI) / 180);
    for (let r = 0; r < 400; r += 0.5) {
      const x = Math.round(cx + r * ux);
      const y = Math.round(cy + r * uy);
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) {
        if (x + dx >= 0 && x + dx < w && y + dy >= 0 && y + dy < h) data[(y + dy) * w + x + dx] = 60;
      }
    }
  }
  return { data, width: w, height: h };
}

describe("detectLine", () => {
  it("finds both halves of a kinked line through the contact point", () => {
    const img = image(240, 300, 15, 170);
    const line = detectLine(img, [{ via: "feet", point: [0.5, 300 / 480] }], 0.1);
    expect(line).not.toBeNull();
    const angles = [...line!.angles].sort((a, b) => a - b);
    expect(Math.abs(angles[0] - 15)).toBeLessThanOrEqual(3);
    expect(Math.abs(angles[1] - 170)).toBeLessThanOrEqual(3);
  });

  it("reports nothing without a line", () => {
    const img = image(-1000, -1000, 0, 180);
    expect(detectLine(img, [{ via: "feet", point: [0.5, 0.6] }], 0.1)).toBeNull();
  });
});

describe("trackLine", () => {
  // 180 directions (2° steps); background level 1 with a little texture, line peaks at 20
  const scores = (peaks: number[]) => {
    const s = Array.from({ length: 180 }, (_, i) => 1 + (i % 3) * 0.1);
    for (const p of peaks) s[Math.round(p / 2) % 180] = 20;
    return s;
  };
  const sample = (i: number, feet: number[], hands: number[], tilt = 0) => ({
    time: i / 15,
    torso: 0.1,
    tilt,
    contacts: [
      { via: "feet" as const, point: [0.5, 0.6] as [number, number], scores: scores(feet) },
      { via: "hands" as const, point: [0.5, 0.3] as [number, number], scores: scores(hands) },
    ],
  });

  it("keeps a steady line and ignores a one-frame distraction", () => {
    // Frame 10: nothing at the feet, a "line" (an arm, a branch) elsewhere at the hands
    const obs = Array.from({ length: 20 }, (_, i) => (i === 10 ? sample(i, [], [90, 270]) : sample(i, [340, 200], [])));
    const lines = trackLine(obs);
    expect(lines[5]?.via).toBe("feet");
    const near = (angles: number[], want: number[]) =>
      [...angles].sort((a, b) => a - b).every((a, i) => Math.abs(a - want[i]) <= 2);
    expect(near(lines[5]!.angles, [200, 340])).toBe(true);
    expect(lines[5]!.seen).toEqual([true, true]);
    expect(lines[10]?.via).toBe("feet");
    expect(lines[10]!.seen).toEqual([false, false]);
    expect(near(lines[10]!.angles, [200, 340])).toBe(true);
  });

  it("follows a half whose angle changes slowly (deeper V at the bottom)", () => {
    const obs = Array.from({ length: 30 }, (_, i) => sample(i, [180, 340 + Math.round(10 * Math.sin(i / 5)) * 2], []));
    const lines = trackLine(obs);
    lines.forEach((l, i) => {
      const want = (340 + Math.round(10 * Math.sin(i / 5)) * 2) % 360;
      expect(l!.angles.some((a) => Math.min(Math.abs(a - want), 360 - Math.abs(a - want)) <= 6)).toBe(true);
    });
  });

  it("moves the contact to the hands while hanging", () => {
    const obs = Array.from({ length: 40 }, (_, i) =>
      i >= 15 && i < 30 ? sample(i, [], [340, 200], 170) : sample(i, [340, 200], []),
    );
    const lines = trackLine(obs);
    expect(lines[5]?.via).toBe("feet");
    expect(lines[22]?.via).toBe("hands");
    expect(lines[36]?.via).toBe("feet");
  });
});
