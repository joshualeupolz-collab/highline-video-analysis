/** Small 1D signal helpers. All functions are pure. */

/** Resamples irregular samples (sorted by time) onto a uniform grid by linear interpolation. */
export function resampleUniform(
  times: number[],
  values: number[],
  rate: number,
  t0: number,
  count: number,
): number[] {
  const out = new Array<number>(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = t0 + i / rate;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    if (times.length === 0) out[i] = 0;
    else if (times.length === 1 || t <= times[0]) out[i] = values[0];
    else if (t >= times[times.length - 1]) out[i] = values[values.length - 1];
    else {
      const a = times[j];
      const b = times[j + 1];
      const f = b > a ? (t - a) / (b - a) : 0;
      out[i] = values[j] * (1 - f) + values[j + 1] * f;
    }
  }
  return out;
}

/** Replaces NaN values by linear interpolation between valid neighbours. */
export function fillGaps(values: number[]): number[] {
  const out = values.slice();
  let last = -1;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) continue;
    if (last === -1) for (let k = 0; k < i; k++) out[k] = out[i];
    else for (let k = last + 1; k < i; k++) out[k] = out[last] + ((out[i] - out[last]) * (k - last)) / (i - last);
    last = i;
  }
  if (last === -1) return out.map(() => 0);
  for (let k = last + 1; k < out.length; k++) out[k] = out[last];
  return out;
}

/** Gaussian smoothing with standard deviation `sigma` samples (edges use the renormalised kernel). */
export function gaussianSmooth(values: number[], sigma: number): number[] {
  if (sigma <= 0) return values.slice();
  const r = Math.ceil(sigma * 3);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    let s = 0;
    let w = 0;
    for (let j = -r; j <= r; j++) {
      const idx = i + j;
      if (idx < 0 || idx >= values.length) continue;
      s += values[idx] * k[j + r];
      w += k[j + r];
    }
    out[i] = s / w;
  }
  return out;
}

/** Centered moving average over `window` samples (shrinks at the edges). */
export function movingAverage(values: number[], window: number): number[] {
  const half = Math.max(0, Math.floor(window / 2));
  const prefix = [0];
  for (const v of values) prefix.push(prefix[prefix.length - 1] + v);
  return values.map((_, i) => {
    const a = Math.max(0, i - half);
    const b = Math.min(values.length, i + half + 1);
    return (prefix[b] - prefix[a]) / (b - a);
  });
}

/** Running median over `window` samples (shrinks at the edges). */
export function medianFilter(values: number[], window: number): number[] {
  const half = Math.max(0, Math.floor(window / 2));
  return values.map((_, i) => {
    const s = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1)).sort((a, b) => a - b);
    return s[s.length >> 1];
  });
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function std(values: number[]): number {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/**
 * Normalised autocorrelation for lags minLag..maxLag (inclusive). Index 0 of the result is minLag.
 */
export function autocorrelation(values: number[], minLag: number, maxLag: number): number[] {
  const m = mean(values);
  const x = values.map((v) => v - m);
  const energy = x.reduce((a, v) => a + v * v, 0) || 1;
  const out: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    // Compensate for the shrinking overlap so long lags are not penalised.
    out.push((s / energy) * (x.length / Math.max(1, x.length - lag)));
  }
  return out;
}

export interface Peak {
  index: number;
  /** Sub-sample position from a parabolic fit. */
  position: number;
  value: number;
  prominence: number;
}

/** Local maxima with their topographic prominence. */
export function findPeaks(values: number[]): Peak[] {
  const peaks: Peak[] = [];
  const n = values.length;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const left = i > 0 ? values[i - 1] : -Infinity;
    if (!(v > left)) continue;
    // Plateaus: walk to the end of equal values
    let j = i;
    while (j + 1 < n && values[j + 1] === v) j++;
    const right = j + 1 < n ? values[j + 1] : -Infinity;
    if (!(v > right)) continue;
    const idx = Math.round((i + j) / 2);
    // Prominence: lowest point on each side before reaching a higher value
    let minL = v;
    for (let k = i - 1; k >= 0 && values[k] <= v; k--) minL = Math.min(minL, values[k]);
    let minR = v;
    for (let k = j + 1; k < n && values[k] <= v; k++) minR = Math.min(minR, values[k]);
    const hitL = i - 1 >= 0 && values.slice(0, i).some((x) => x > v);
    const hitR = j + 1 < n && values.slice(j + 1).some((x) => x > v);
    let base: number;
    if (hitL && hitR) base = Math.max(minL, minR);
    else if (hitL) base = minL;
    else if (hitR) base = minR;
    else base = Math.min(minL, minR);
    let position = idx;
    if (i === j && i > 0 && i < n - 1) {
      const d = values[i - 1] - 2 * v + values[i + 1];
      if (d < 0) position = i + (0.5 * (values[i - 1] - values[i + 1])) / d;
    }
    peaks.push({ index: idx, position, value: v, prominence: v - base });
    i = j;
  }
  return peaks;
}
