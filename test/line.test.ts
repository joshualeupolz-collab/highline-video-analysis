import { describe, expect, it } from "vitest";
import { detectLine, type GrayImage } from "../src/analysis/pose/line";

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
