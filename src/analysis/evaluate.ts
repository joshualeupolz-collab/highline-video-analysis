/** Compares suggested cut points with hand-marked ones. */

export interface Match {
  truth: number;
  predicted: number;
  error: number;
}

export interface Evaluation {
  matches: Match[];
  /** Hand marks without a suggestion within the tolerance. */
  missed: number[];
  /** Suggestions without a hand mark within the tolerance. */
  extra: number[];
  /** matched / hand marks */
  recall: number;
  /** matched / suggestions */
  precision: number;
  meanAbsError: number;
}

/** One-to-one matching, closest pairs first, within `tolerance` seconds. */
export function evaluateCutPoints(truth: number[], predicted: number[], tolerance = 0.3): Evaluation {
  const pairs: { i: number; j: number; d: number }[] = [];
  truth.forEach((t, i) =>
    predicted.forEach((p, j) => {
      const d = Math.abs(p - t);
      if (d <= tolerance) pairs.push({ i, j, d });
    }),
  );
  pairs.sort((a, b) => a.d - b.d);
  const usedT = new Set<number>();
  const usedP = new Set<number>();
  const matches: Match[] = [];
  for (const { i, j } of pairs) {
    if (usedT.has(i) || usedP.has(j)) continue;
    usedT.add(i);
    usedP.add(j);
    matches.push({ truth: truth[i], predicted: predicted[j], error: predicted[j] - truth[i] });
  }
  matches.sort((a, b) => a.truth - b.truth);
  return {
    matches,
    missed: truth.filter((_, i) => !usedT.has(i)),
    extra: predicted.filter((_, j) => !usedP.has(j)),
    recall: truth.length ? matches.length / truth.length : NaN,
    precision: predicted.length ? matches.length / predicted.length : NaN,
    meanAbsError: matches.length ? matches.reduce((a, m) => a + Math.abs(m.error), 0) / matches.length : NaN,
  };
}
