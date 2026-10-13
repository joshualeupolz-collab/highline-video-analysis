/**
 * Experimental: finds the tensioned highline next to the athlete in one frame.
 *
 * The tensioned line runs straight from the contact point (feet when standing on it, hands when
 * hanging) towards both anchors; it kinks at the contact point. So from the contact point, rays in
 * all directions are scored for a thin straight line (a ridge across the ray, one polarity along
 * it), and the best pair of rays pointing roughly away from each other is taken. The slack backup
 * line hangs in a curve and scores lower on straight rays.
 */

export interface GrayImage {
  data: Float32Array;
  width: number;
  height: number;
}

export interface LineEstimate {
  /** Contact point in frame-width units. */
  contact: [number, number];
  /** Directions of the two line halves from the contact point (degrees, 0 = right, 90 = down). */
  angles: [number, number];
  /** Length of the scored rays (frame-width units), from `start` to `start + reach`. */
  start: number;
  reach: number;
  /** Ray score against the median ray (higher = clearer line). */
  score: number;
  via: "feet" | "hands";
}

export interface LineOptions {
  /** Angle step of the ray search (degrees). */
  step: number;
  /** The two halves must differ by at least this angle (degrees). */
  minOpening: number;
  /** Ray length in frame widths, and start distance in torso lengths. */
  reach: number;
  startTorso: number;
  /** Ridge half-widths to try, in pixels of a 480 px wide image. */
  widths: number[];
  /** Below this score no line is reported. */
  minScore: number;
}

export const defaultLineOptions: LineOptions = {
  step: 3,
  minOpening: 130,
  reach: 0.3,
  startTorso: 0.6,
  widths: [1.5, 3],
  minScore: 6,
};

function sample(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const w = img.width;
  const i = y0 * w + x0;
  const d = img.data;
  return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
}

/** Line-likeness of a ray from (cx, cy) in direction a (radians), image pixels. */
function rayScore(img: GrayImage, cx: number, cy: number, a: number, r0: number, r1: number, widths: number[]): number {
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const nx = -uy;
  const ny = ux;
  let best = 0;
  for (const d of widths) {
    let sum = 0;
    let signSum = 0;
    let n = 0;
    let total = 0;
    for (let r = r0; r < r1; r += 2) {
      total++;
      const x = cx + r * ux;
      const y = cy + r * uy;
      if (x < d + 1 || y < d + 1 || x > img.width - d - 2 || y > img.height - d - 2) continue;
      const a0 = sample(img, x, y);
      const ap = sample(img, x + d * nx, y + d * ny);
      const am = sample(img, x - d * nx, y - d * ny);
      const ridge = 2 * a0 - ap - am;
      const v = Math.abs(ridge) - Math.abs(ap - am);
      if (v > 0) sum += v;
      signSum += Math.sign(ridge);
      n++;
    }
    if (n < total * 0.5) continue;
    // Mean ridge strength, times how consistently the line is darker (or lighter) than its sides
    best = Math.max(best, (sum / n) * Math.abs(signSum / n));
  }
  return best;
}

/**
 * `candidates` are possible contact points in frame-width units; `torso` the torso length in the
 * same units; `prev` a recent estimate to prefer similar directions.
 */
export function detectLine(
  img: GrayImage,
  candidates: { via: LineEstimate["via"]; point: [number, number] }[],
  torso: number,
  prev: LineEstimate | null = null,
  options: Partial<LineOptions> = {},
): LineEstimate | null {
  const o = { ...defaultLineOptions, ...options };
  const k = img.width; // pixels per frame-width unit
  const widths = o.widths.map((w) => (w * img.width) / 480);
  const n = Math.round(360 / o.step);
  let best: LineEstimate | null = null;
  for (const c of candidates) {
    const cx = c.point[0] * k;
    const cy = c.point[1] * k;
    const r0 = o.startTorso * torso * k;
    const r1 = r0 + o.reach * k;
    const scores: number[] = [];
    for (let i = 0; i < n; i++) scores.push(rayScore(img, cx, cy, (i * o.step * Math.PI) / 180, r0, r1, widths));
    const sorted = [...scores].sort((a, b) => a - b);
    const base = sorted[sorted.length >> 1] + 1e-3;
    const prior = (i: number, j: number) => {
      if (!prev) return 1;
      const d = (x: number, y: number) => {
        const e = Math.abs(((x - y) % 360) + 360) % 360;
        return e > 180 ? 360 - e : e;
      };
      const ai = i * o.step;
      const aj = j * o.step;
      const dd = Math.min(d(ai, prev.angles[0]) + d(aj, prev.angles[1]), d(ai, prev.angles[1]) + d(aj, prev.angles[0]));
      return 1 + 0.5 * Math.exp(-(dd * dd) / (2 * 30 * 30));
    };
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const opening = Math.min((j - i) * o.step, 360 - (j - i) * o.step);
        if (opening < o.minOpening) continue;
        const score = ((scores[i] + scores[j]) / (2 * base)) * prior(i, j);
        if (!best || score > best.score) {
          best = {
            contact: c.point,
            angles: [i * o.step, j * o.step],
            start: o.startTorso * torso,
            reach: o.reach,
            score,
            via: c.via,
          };
        }
      }
    }
  }
  return best && best.score >= o.minScore ? best : null;
}
