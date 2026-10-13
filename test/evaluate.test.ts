import { describe, expect, it } from "vitest";
import { evaluateCutPoints } from "../src/analysis/evaluate";

describe("evaluateCutPoints", () => {
  it("matches one to one within the tolerance", () => {
    const ev = evaluateCutPoints([1, 4, 7, 10], [1.1, 3.6, 4.2, 9.0], 0.3);
    expect(ev.matches.map((m) => m.truth)).toEqual([1, 4]);
    expect(ev.missed).toEqual([7, 10]);
    expect(ev.extra).toEqual([3.6, 9.0]);
    expect(ev.recall).toBe(0.5);
    expect(ev.precision).toBe(0.5);
    expect(ev.meanAbsError).toBeCloseTo(0.15);
  });
});
