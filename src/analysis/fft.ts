/**
 * Minimal in-place radix-2 complex FFT (1D and 2D). Sizes must be powers of two.
 */

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    twiddleCache.set(n, t);
  }
  return t;
}

/**
 * In-place FFT of `n` complex values stored with the given stride, starting at `offset`.
 * Forward uses e^{-i...}; inverse uses e^{+i...} and scales by 1/n.
 */
export function fft1d(
  re: Float64Array,
  im: Float64Array,
  n: number,
  inverse = false,
  offset = 0,
  stride = 1,
): void {
  if (!isPowerOfTwo(n)) throw new Error(`FFT size must be a power of two, got ${n}`);
  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = offset + i * stride;
      const b = offset + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sign * sin[k * step];
        const a = offset + (start + k) * stride;
        const b = offset + (start + k + half) * stride;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      const a = offset + i * stride;
      re[a] /= n;
      im[a] /= n;
    }
  }
}

/** In-place 2D FFT of a row-major `width` x `height` complex image. */
export function fft2d(
  re: Float64Array,
  im: Float64Array,
  width: number,
  height: number,
  inverse = false,
): void {
  for (let y = 0; y < height; y++) fft1d(re, im, width, inverse, y * width, 1);
  for (let x = 0; x < width; x++) fft1d(re, im, height, inverse, x, width);
}
