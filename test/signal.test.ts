import { describe, expect, it } from "vitest";
import { autocorrelation, fillGaps, findPeaks, gaussianSmooth, resampleUniform } from "../src/analysis/signal";

describe("signal helpers", () => {
  it("resamples irregular samples linearly", () => {
    expect(resampleUniform([0, 1, 3], [0, 10, 30], 1, 0, 4)).toEqual([0, 10, 20, 30]);
  });

  it("fills NaN gaps", () => {
    expect(fillGaps([NaN, 1, NaN, 3, NaN])).toEqual([1, 1, 2, 3, 3]);
  });

  it("keeps a constant signal constant when smoothing", () => {
    expect(gaussianSmooth([5, 5, 5, 5], 1.5).every((v) => Math.abs(v - 5) < 1e-9)).toBe(true);
  });

  it("finds peaks with prominence", () => {
    const p = findPeaks([0, 2, 1, 5, 0, 3, 0]);
    expect(p.map((x) => x.index)).toEqual([1, 3, 5]);
    expect(p.map((x) => x.prominence)).toEqual([1, 5, 3]);
  });

  it("autocorrelation peaks at the period", () => {
    const x = Array.from({ length: 300 }, (_, i) => Math.sin((2 * Math.PI * i) / 45));
    const ac = autocorrelation(x, 20, 80);
    const best = ac.indexOf(Math.max(...ac)) + 20;
    expect(best).toBe(45);
  });
});
