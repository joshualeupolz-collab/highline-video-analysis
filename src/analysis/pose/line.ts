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
  widths: [1.5, 3, 6],
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

/** Line-likeness of rays in `directions` evenly spaced directions (index i = i * 360 / directions degrees). */
export function rayScores(
  img: GrayImage,
  point: [number, number],
  torso: number,
  directions = 90,
  options: Partial<LineOptions> = {},
): number[] {
  const o = { ...defaultLineOptions, ...options };
  const k = img.width;
  const widths = o.widths.map((w) => (w * img.width) / 480);
  const cx = point[0] * k;
  const cy = point[1] * k;
  const r0 = o.startTorso * torso * k;
  const r1 = r0 + o.reach * k;
  const out: number[] = [];
  for (let i = 0; i < directions; i++) out.push(rayScore(img, cx, cy, (i * 2 * Math.PI) / directions, r0, r1, widths));
  return out;
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

/** What one pose sample saw of the line: ray scores from the possible contact points. */
export interface LineObservation {
  time: number;
  torso: number;
  contacts: { via: LineEstimate["via"]; point: [number, number]; scores: number[] }[];
}

export interface LineTrackOptions {
  /** Orientation steps of the state grid (degrees; must be a multiple of 360 / scores.length). */
  orientationStep: number;
  /** Kink steps (degrees, the two halves deviate by kink / 2 each from a straight line). */
  kinkStep: number;
  maxKink: number;
  /** Typical change per second of the line direction and of the kink (degrees). */
  turnPerSecond: number;
  kinkPerSecond: number;
  /** Cost of switching between feet and hands as the contact. */
  switchCost: number;
  /** Cost when the two halves bend downwards from the contact (Λ instead of V). */
  wrongBendCost: number;
  /** Below this mean score (vs. the median ray) the line counts as not seen. */
  minScore: number;
}

export const defaultLineTrackOptions: LineTrackOptions = {
  orientationStep: 4,
  kinkStep: 8,
  maxKink: 64,
  turnPerSecond: 90,
  kinkPerSecond: 120,
  switchCost: 4,
  wrongBendCost: 1.5,
  minScore: 3,
};

/**
 * Follows the line through all samples (Viterbi): its direction and kink change slowly, the contact
 * stays on the feet (or the hands) unless the evidence clearly says otherwise, and the halves
 * usually rise from the contact point in a V. Returns one estimate (or null when unseen) per sample.
 */
export function trackLine(obs: LineObservation[], options: Partial<LineTrackOptions> = {}): (LineEstimate | null)[] {
  const o = { ...defaultLineTrackOptions, ...options };
  if (!obs.length) return [];
  const dirs = obs.find((x) => x.contacts.length)?.contacts[0].scores.length ?? 90;
  const degPerDir = 360 / dirs;
  const nO = Math.round(180 / o.orientationStep);
  const nK = Math.round((2 * o.maxKink) / o.kinkStep) + 1;
  const vias: LineEstimate["via"][] = ["feet", "hands"];
  const nS = 2 * nO * nK;
  const state = (v: number, oi: number, ki: number) => (v * nO + oi) * nK + ki;
  const anglesOf = (oi: number, ki: number): [number, number] => {
    const orient = oi * o.orientationStep;
    const kink = -o.maxKink + ki * o.kinkStep;
    return [orient + kink / 2, orient + 180 - kink / 2];
  };
  const wrongBend = new Float64Array(nO * nK);
  for (let oi = 0; oi < nO; oi++)
    for (let ki = 0; ki < nK; ki++) {
      const [a, b] = anglesOf(oi, ki).map((x) => (x * Math.PI) / 180);
      // Bisector of the two halves: pointing down (y > 0) means both halves fall away from the contact
      const by = Math.sin(a) + Math.sin(b);
      wrongBend[oi * nK + ki] = by > 0.2 ? o.wrongBendCost : 0;
    }

  const scoreAt = (scores: number[], deg: number) => {
    const i = Math.round((((deg % 360) + 360) % 360) / degPerDir) % dirs;
    return scores[i];
  };

  // Observation cost per state: minus the mean normalised score of the two halves (capped)
  const obsCost = (x: LineObservation, out: Float64Array, norm: Float64Array) => {
    out.fill(5);
    norm.fill(0);
    for (const c of x.contacts) {
      const v = vias.indexOf(c.via);
      const sorted = [...c.scores].sort((p, q) => p - q);
      const base = sorted[sorted.length >> 1] + 1e-3;
      for (let oi = 0; oi < nO; oi++)
        for (let ki = 0; ki < nK; ki++) {
          const [a, b] = anglesOf(oi, ki);
          const score = (scoreAt(c.scores, a) + scoreAt(c.scores, b)) / (2 * base);
          const s = state(v, oi, ki);
          norm[s] = score;
          out[s] = -Math.min(score, 12) / 3 + wrongBend[oi * nK + ki];
        }
    }
  };

  let cost = new Float64Array(nS);
  let next = new Float64Array(nS);
  const back: Int32Array[] = [];
  const norms: Float64Array[] = [];
  const oc = new Float64Array(nS);
  let lastTime = obs[0].time;
  const wO = 3;
  const wK = 2;
  obs.forEach((x, t) => {
    const norm = new Float64Array(nS);
    obsCost(x, oc, norm);
    norms.push(norm);
    const bk = new Int32Array(nS);
    if (t === 0) {
      cost.set(oc);
      back.push(bk);
      lastTime = x.time;
      return;
    }
    const dt = Math.max(1 / 60, x.time - lastTime);
    lastTime = x.time;
    const sO = Math.max(o.orientationStep, o.turnPerSecond * dt);
    const sK = Math.max(o.kinkStep, o.kinkPerSecond * dt);
    for (let v = 0; v < 2; v++)
      for (let oi = 0; oi < nO; oi++)
        for (let ki = 0; ki < nK; ki++) {
          let best = Infinity;
          let arg = 0;
          for (let pv = 0; pv < 2; pv++)
            for (let d = -wO; d <= wO; d++) {
              const raw = oi + d;
              const wrapped = raw < 0 || raw >= nO;
              const po = (raw + nO) % nO;
              const dO = (d * o.orientationStep) / sO;
              for (let e = -wK; e <= wK; e++) {
                const k2 = ki + e;
                if (k2 < 0 || k2 >= nK) continue;
                // Orientation wraps at 180°: then the same line has the mirrored kink index
                const pk = wrapped ? nK - 1 - k2 : k2;
                const dK = (e * o.kinkStep) / sK;
                const c = cost[state(pv, po, pk)] + dO * dO + dK * dK + (pv !== v ? o.switchCost : 0);
                if (c < best) {
                  best = c;
                  arg = state(pv, po, pk);
                }
              }
            }
          const s = state(v, oi, ki);
          next[s] = best + oc[s];
          bk[s] = arg;
        }
    [cost, next] = [next, cost];
    back.push(bk);
  });

  let s = 0;
  for (let i = 1; i < nS; i++) if (cost[i] < cost[s]) s = i;
  const out: (LineEstimate | null)[] = new Array(obs.length).fill(null);
  for (let t = obs.length - 1; t >= 0; t--) {
    const v = Math.floor(s / (nO * nK));
    const oi = Math.floor((s % (nO * nK)) / nK);
    const ki = s % nK;
    const c = obs[t].contacts.find((x) => x.via === vias[v]);
    const score = norms[t][s];
    if (c && score >= o.minScore) {
      const [a, b] = anglesOf(oi, ki);
      out[t] = {
        contact: c.point,
        angles: [((a % 360) + 360) % 360, ((b % 360) + 360) % 360],
        start: defaultLineOptions.startTorso * obs[t].torso,
        reach: defaultLineOptions.reach,
        score,
        via: vias[v],
      };
    }
    s = back[t][s];
  }
  return out;
}
