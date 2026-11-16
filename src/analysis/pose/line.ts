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
  /** Whether each half was actually seen in this frame (else it is the tracked guess). */
  seen?: [boolean, boolean];
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
  reach: 0.35,
  startTorso: 0.5,
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
  directions = 180,
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
  /** Torso tilt in degrees (0 = upright), to tell standing from hanging. */
  tilt: number;
  contacts: { via: LineEstimate["via"]; point: [number, number]; scores: number[] }[];
}

export interface LineTrackOptions {
  /** The two halves' main directions must differ by at least this angle (degrees). */
  minOpening: number;
  /** A half may deviate from its main direction by up to this angle (degrees) in a frame. */
  maxDeviation: number;
  /** Deviation (degrees) that costs as much as one unit of score. */
  deviationScale: number;
  /** Typical change of a half's direction per second (degrees). */
  turnPerSecond: number;
  /** Cost of switching between feet and hands as the contact. */
  switchCost: number;
  /** Cost for feet as contact when not upright, and for hands when upright. */
  postureCost: number;
  /** A half counts as seen in a frame from this score (vs. the median ray) on. */
  minScore: number;
}

export const defaultLineTrackOptions: LineTrackOptions = {
  minOpening: 120,
  maxDeviation: 30,
  deviationScale: 40,
  turnPerSecond: 120,
  switchCost: 6,
  postureCost: 4,
  minScore: 2,
};

/** Scores divided by their median, capped, and widened by one direction step. */
function normalised(scores: number[], cap = 10): number[] {
  const positive = scores.filter((v) => v > 0).sort((p, q) => p - q);
  const base = (positive.length ? positive[positive.length >> 1] : 1) + 1e-3;
  const n = scores.map((v) => Math.min(v / base, cap));
  return n.map((v, i) => Math.max(v, n[(i + 1) % n.length], n[(i + n.length - 1) % n.length]));
}

/**
 * Follows the line through the whole video.
 *
 * 1. Main directions: the anchors do not move, so over the video each half of the line points in
 *    about the same direction. The two best directions (at least `minOpening` apart) of the mean
 *    ray score over all upright samples are the halves' main directions. A branch or an arm that
 *    looks like a line in a few frames cannot win this vote.
 * 2. Contact: feet or hands per sample, whichever sees the halves better (2-state Viterbi with a
 *    switching cost and a posture prior).
 * 3. Per half a Viterbi over the deviation from its main direction (the V gets steeper at the
 *    bottom of a bounce): high ray score, small deviation, slow change.
 *
 * Returns one estimate per observation, or null where there is no contact point.
 */
export function trackLine(obs: LineObservation[], options: Partial<LineTrackOptions> = {}): (LineEstimate | null)[] {
  const o = { ...defaultLineTrackOptions, ...options };
  const first = obs.find((x) => x.contacts.length);
  if (!first) return obs.map(() => null);
  const dirs = first.contacts[0].scores.length;
  const step = 360 / dirs;
  const vias: LineEstimate["via"][] = ["feet", "hands"];
  const norm = obs.map((x) => vias.map((v) => {
    const c = x.contacts.find((k) => k.via === v);
    return c ? normalised(c.scores) : null;
  }));

  // 1. Main directions from upright samples' feet: the direction whose ±maxDeviation window
  // holds a clear line in the most samples
  const R = Math.round(o.maxDeviation / step);
  const windowMax = (n: number[], d: number) => {
    let best = 0;
    for (let k = -R; k <= R; k++) best = Math.max(best, n[(d + k + dirs) % dirs]);
    return best;
  };
  const votes = new Array<number>(dirs).fill(0);
  const vote = (n: number[]) => {
    for (let i = 0; i < dirs; i++) votes[i] += Math.min(windowMax(n, i), 6);
  };
  let count = 0;
  obs.forEach((x, t) => {
    const n = norm[t][0];
    if (!n || !(Math.abs(x.tilt) < 70)) return;
    vote(n);
    count++;
  });
  if (!count) {
    // Never upright on the feet: use whatever contact there is
    for (const pair of norm) {
      const n = pair[0] ?? pair[1];
      if (n) vote(n);
    }
  }
  const apart = (i: number, j: number) => {
    const d = Math.abs(i - j) % dirs;
    return Math.min(d, dirs - d) * step;
  };
  /** Best direction among the allowed ones; on a plateau of equally good ones, its middle. */
  const pick = (allowed: (i: number) => boolean) => {
    let best = -1;
    for (let i = 0; i < dirs; i++) if (allowed(i) && (best < 0 || votes[i] > votes[best])) best = i;
    if (best < 0) return 0;
    const level = votes[best] * 0.98;
    let lo = 0;
    let hi = 0;
    while (lo > -dirs / 4 && allowed((best + lo - 1 + dirs) % dirs) && votes[(best + lo - 1 + dirs) % dirs] >= level) lo--;
    while (hi < dirs / 4 && allowed((best + hi + 1) % dirs) && votes[(best + hi + 1) % dirs] >= level) hi++;
    return (best + Math.round((lo + hi) / 2) + dirs) % dirs;
  };
  const d1 = pick(() => true);
  const d2 = pick((i) => apart(i, d1) >= o.minOpening);
  const main = [d1, d2];

  // 2. Contact per sample
  const gain = obs.map((x, t) =>
    vias.map((v, c) => {
      const n = norm[t][c];
      if (!n) return -50;
      const upright = Math.abs(x.tilt) < 60;
      const wrongPosture = (v === "hands") === upright;
      return Math.min(windowMax(n, d1), 6) + Math.min(windowMax(n, d2), 6) - (wrongPosture ? o.postureCost : 0);
    }),
  );
  const choice = new Array<number>(obs.length).fill(0);
  {
    let cost = [0, 0];
    const back: number[][] = [];
    for (let t = 0; t < obs.length; t++) {
      const next = [0, 0];
      const arg = [0, 0];
      for (let c = 0; c < 2; c++) {
        const stay = cost[c];
        const move = cost[1 - c] + o.switchCost;
        arg[c] = stay <= move ? c : 1 - c;
        next[c] = Math.min(stay, move) - gain[t][c];
      }
      cost = next;
      back.push(arg);
    }
    let c = cost[0] <= cost[1] ? 0 : 1;
    for (let t = obs.length - 1; t >= 0; t--) {
      choice[t] = c;
      c = back[t][c];
    }
  }

  // 3. Deviation from the main direction per half
  const K = 2 * R + 1;
  const paths = main.map((d) => {
    let cost = new Float64Array(K);
    const back: Int16Array[] = [];
    for (let t = 0; t < obs.length; t++) {
      const n = norm[t][choice[t]];
      const oc = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        const off = (k - R) * step;
        oc[k] = -(n ? Math.min(n[(d + k - R + dirs) % dirs], 8) : 0) / 2 + (off / o.deviationScale) ** 2;
      }
      const bk = new Int16Array(K);
      if (t === 0) {
        cost = oc;
        back.push(bk);
        continue;
      }
      const dt = Math.max(1 / 60, obs[t].time - obs[t - 1].time);
      const s = Math.max(2 * step, o.turnPerSecond * dt);
      const next = new Float64Array(K);
      for (let k = 0; k < K; k++) {
        let best = Infinity;
        let arg = 0;
        for (let j = 0; j < K; j++) {
          const c = cost[j] + (((k - j) * step) / s) ** 2;
          if (c < best) {
            best = c;
            arg = j;
          }
        }
        next[k] = best + oc[k];
        bk[k] = arg;
      }
      cost = next;
      back.push(bk);
    }
    let k = 0;
    for (let j = 1; j < K; j++) if (cost[j] < cost[k]) k = j;
    const path = new Array<number>(obs.length).fill(0);
    for (let t = obs.length - 1; t >= 0; t--) {
      path[t] = (d + k - R + dirs) % dirs;
      k = back[t][k];
    }
    return path;
  });

  return obs.map((x, t) => {
    const n = norm[t][choice[t]];
    const c = x.contacts.find((k) => k.via === vias[choice[t]]);
    if (!n || !c) return null;
    const s = [n[paths[0][t]], n[paths[1][t]]];
    return {
      contact: c.point,
      angles: [paths[0][t] * step, paths[1][t] * step],
      start: defaultLineOptions.startTorso * x.torso,
      reach: defaultLineOptions.reach,
      score: (s[0] + s[1]) / 2,
      via: vias[choice[t]],
      seen: [s[0] >= o.minScore, s[1] >= o.minScore],
    };
  });
}
