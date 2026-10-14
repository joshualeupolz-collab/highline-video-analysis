/**
 * Offline pose tracking: the whole video has been sampled already, so the best sequence of poses can
 * be chosen with knowledge of what comes before *and* after.
 *
 * 1. Every sample holds a few candidate poses (different crops, plus each with left/right swapped).
 *    A Viterbi search picks one candidate (or none) per sample so that joints do not jump, bones
 *    keep their length and the body does not turn faster than a person can.
 * 2. Single joints that still stick out from their neighbours in time are dropped.
 * 3. Gaps up to `maxGap` seconds are filled by moving the body along: the hip centre and the torso
 *    angle (unwrapped, so a flip keeps turning) are interpolated, and the limbs keep their shape
 *    relative to the torso.
 * 4. A light temporal smoothing removes jitter.
 */
import { KEYPOINTS, type PoseFrame } from "./types";

export interface PoseCandidate {
  points: number[];
  source: PoseFrame["source"];
}

export interface PoseSample {
  time: number;
  candidates: PoseCandidate[];
}

export interface TrackOptions {
  /** Joints are visible from this visibility on. */
  minVisibility: number;
  /** Joint speed (torso lengths per second) that is free; faster movement costs. */
  freeSpeed: number;
  /** Torso turn rate (degrees per second) that is free; faster turning costs. */
  freeTurn: number;
  /** Cost of a sample without a pose (vs. a candidate that fits perfectly = 0). */
  noneCost: number;
  /** Weights of the cost terms. */
  jumpWeight: number;
  turnWeight: number;
  boneWeight: number;
  /** A joint further than this (torso lengths) from the mean of its neighbours in time is dropped. */
  outlier: number;
  /** Longest gap (seconds) filled by interpolation. */
  maxGap: number;
  /** Times at which to put interpolated poses into gaps (e.g. all sample times). */
  fillTimes?: number[];
}

export const defaultTrackOptions: TrackOptions = {
  minVisibility: 0.3,
  freeSpeed: 6,
  freeTurn: 900,
  noneCost: 3,
  jumpWeight: 2,
  turnWeight: 6,
  boneWeight: 1.5,
  outlier: 0.6,
  maxGap: 0.6,
};

const idx = Object.fromEntries(KEYPOINTS.map((k, i) => [k, i])) as Record<(typeof KEYPOINTS)[number], number>;
const N = KEYPOINTS.length;

/** Keypoint index pairs that are swapped when left and right are exchanged. */
const SWAP: number[] = KEYPOINTS.map((k) => {
  const other = k.startsWith("left") ? k.replace("left", "right") : k.startsWith("right") ? k.replace("right", "left") : k;
  return idx[other as (typeof KEYPOINTS)[number]];
});

const BONES: [number, number][] = [
  [idx.leftShoulder, idx.leftElbow],
  [idx.leftElbow, idx.leftWrist],
  [idx.rightShoulder, idx.rightElbow],
  [idx.rightElbow, idx.rightWrist],
  [idx.leftHip, idx.leftKnee],
  [idx.leftKnee, idx.leftAnkle],
  [idx.rightHip, idx.rightKnee],
  [idx.rightKnee, idx.rightAnkle],
  [idx.leftShoulder, idx.leftHip],
  [idx.rightShoulder, idx.rightHip],
];

export function swapLeftRight(points: number[]): number[] {
  const out = new Array<number>(points.length);
  for (let k = 0; k < N; k++) {
    const s = SWAP[k];
    out[k * 3] = points[s * 3];
    out[k * 3 + 1] = points[s * 3 + 1];
    out[k * 3 + 2] = points[s * 3 + 2];
  }
  return out;
}

type Pt = [number, number];

function pt(points: number[], k: number, minVis: number): Pt | null {
  return points[k * 3 + 2] >= minVis ? [points[k * 3], points[k * 3 + 1]] : null;
}

function midOf(points: number[], a: number, b: number, minVis: number): Pt | null {
  const pa = pt(points, a, minVis);
  const pb = pt(points, b, minVis);
  if (pa && pb) return [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
  return pa ?? pb;
}

interface Body {
  centre: Pt | null;
  /** Torso direction hip → shoulder in degrees (0 = up, clockwise). */
  angle: number;
  torso: number;
}

function body(points: number[], minVis: number): Body {
  const s = midOf(points, idx.leftShoulder, idx.rightShoulder, minVis);
  const h = midOf(points, idx.leftHip, idx.rightHip, minVis);
  if (!s || !h) return { centre: h ?? s, angle: NaN, torso: NaN };
  return {
    centre: h,
    angle: (Math.atan2(s[0] - h[0], -(s[1] - h[1])) * 180) / Math.PI,
    torso: Math.hypot(s[0] - h[0], s[1] - h[1]),
  };
}

function angleDiff(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
}

function meanVisibility(points: number[]): number {
  let s = 0;
  for (let k = 0; k < N; k++) s += points[k * 3 + 2];
  return s / N;
}

/** Picks one candidate per sample (or none) along the most plausible path, then cleans and fills it. */
export function trackPoses(samples: PoseSample[], options: Partial<TrackOptions> = {}): PoseFrame[] {
  const o = { ...defaultTrackOptions, ...options };
  // Every candidate also in a left/right swapped version
  const cands = samples.map((s) =>
    s.candidates.flatMap((c) => [
      { ...c, swapped: false, body: body(c.points, o.minVisibility), vis: meanVisibility(c.points) },
      {
        points: swapLeftRight(c.points),
        source: c.source,
        swapped: true,
        body: body(c.points, o.minVisibility),
        vis: meanVisibility(c.points),
      },
    ]),
  );

  // Typical torso and bone lengths over the whole video (from the most visible candidates)
  const firsts = cands.map((c) => c[0]).filter(Boolean);
  const torso = median(firsts.map((c) => c.body.torso));
  if (!Number.isFinite(torso)) return [];
  const boneLen = BONES.map(([a, b]) =>
    median(
      firsts.map((c) => {
        const pa = pt(c.points, a, o.minVisibility);
        const pb = pt(c.points, b, o.minVisibility);
        return pa && pb ? Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) : NaN;
      }),
    ),
  );

  const dataCost = (c: (typeof cands)[number][number]) => {
    let bone = 0;
    let n = 0;
    BONES.forEach(([a, b], i) => {
      const pa = pt(c.points, a, o.minVisibility);
      const pb = pt(c.points, b, o.minVisibility);
      if (!pa || !pb || !(boneLen[i] > 0)) return;
      bone += Math.abs(Math.log(Math.max(1e-6, Math.hypot(pa[0] - pb[0], pa[1] - pb[1])) / boneLen[i]));
      n++;
    });
    return (1 - c.vis) + o.boneWeight * (n ? bone / n : 1) + (c.swapped ? 0.05 : 0);
  };

  const transCost = (a: (typeof cands)[number][number], b: (typeof cands)[number][number], dt: number) => {
    let sum = 0;
    let n = 0;
    for (let k = 0; k < N; k++) {
      const pa = pt(a.points, k, o.minVisibility);
      const pb = pt(b.points, k, o.minVisibility);
      if (!pa || !pb) continue;
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) / torso;
      const excess = Math.max(0, d - o.freeSpeed * dt);
      sum += excess * excess;
      n++;
    }
    let cost = o.jumpWeight * (n ? sum / n : 1);
    if (Number.isFinite(a.body.angle) && Number.isFinite(b.body.angle)) {
      // Turning faster than a person can is (almost) never right: a run of flipped skeletons must
      // cost more than leaving those samples empty and filling them in from both sides
      const turn = Math.max(0, angleDiff(a.body.angle, b.body.angle) - o.freeTurn * dt) / 45;
      cost += o.turnWeight * turn * turn;
    }
    return cost;
  };

  // Viterbi over candidates; state -1 = no pose. Transitions skip over "no pose" samples by
  // remembering the last real pose of each path (its time and candidate).
  type State = { cost: number; back: number; lastSample: number; lastCand: number };
  const layers: State[][] = [];
  for (let i = 0; i < samples.length; i++) {
    const layer: State[] = [];
    const prev = layers[i - 1];
    // "none" state
    const noneFrom = prev ? prev.reduce((best, s, j) => (s.cost < prev[best].cost ? j : best), 0) : -1;
    layer.push({
      cost: (prev ? prev[noneFrom].cost : 0) + o.noneCost,
      back: noneFrom,
      lastSample: prev ? prev[noneFrom].lastSample : -1,
      lastCand: prev ? prev[noneFrom].lastCand : -1,
    });
    cands[i].forEach((c, ci) => {
      const d = dataCost(c);
      let best: State = { cost: Infinity, back: -1, lastSample: i, lastCand: ci };
      if (!prev) best = { cost: d, back: -1, lastSample: i, lastCand: ci };
      else {
        prev.forEach((s, j) => {
          let t = 0;
          if (s.lastSample >= 0) {
            const dt = Math.max(1e-3, samples[i].time - samples[s.lastSample].time);
            // After a long gap the previous pose says little
            t = dt > o.maxGap * 2 ? 0 : transCost(cands[s.lastSample][s.lastCand], c, dt);
          }
          const total = s.cost + d + t;
          if (total < best.cost) best = { cost: total, back: j, lastSample: i, lastCand: ci };
        });
      }
      layer.push(best);
    });
    layers.push(layer);
  }

  // Backtrack
  const chosen: (number[] | null)[] = new Array(samples.length).fill(null);
  const sources: PoseFrame["source"][] = new Array(samples.length).fill("track");
  if (layers.length) {
    const last = layers[layers.length - 1];
    let j = last.reduce((best, s, k) => (s.cost < last[best].cost ? k : best), 0);
    for (let i = layers.length - 1; i >= 0; i--) {
      if (j > 0) {
        const c = cands[i][j - 1];
        chosen[i] = c.points.slice();
        sources[i] = c.source;
      }
      j = layers[i][j].back;
    }
  }

  const times = samples.map((s) => s.time);
  dropOutliers(chosen, times, torso, o);
  const filled = fillGaps(chosen, times, o);
  smooth(filled, o);
  return filled
    .map((f) =>
      f.points ? ({ time: f.time, points: f.points.map((v) => round(v)), source: f.interpolated ? "interpolated" : sources[f.i] } as PoseFrame) : null,
    )
    .filter((f): f is PoseFrame => !!f);
}

/** Drops single joints far from the mean of their neighbours in time. */
function dropOutliers(chosen: (number[] | null)[], times: number[], torso: number, o: TrackOptions) {
  const n = chosen.length;
  const drop: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const cur = chosen[i];
    if (!cur) continue;
    // nearest chosen neighbours on each side within 0.3 s
    let a = i - 1;
    while (a >= 0 && !chosen[a]) a--;
    let b = i + 1;
    while (b < n && !chosen[b]) b++;
    if (a < 0 || b >= n || times[i] - times[a] > 0.3 || times[b] - times[i] > 0.3) continue;
    const f = (times[i] - times[a]) / (times[b] - times[a]);
    for (let k = 0; k < N; k++) {
      const pc = pt(cur, k, o.minVisibility);
      const pa = pt(chosen[a]!, k, o.minVisibility);
      const pb = pt(chosen[b]!, k, o.minVisibility);
      if (!pc || !pa || !pb) continue;
      const ex = pa[0] + (pb[0] - pa[0]) * f;
      const ey = pa[1] + (pb[1] - pa[1]) * f;
      const neighbours = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      // Only when the neighbours agree with each other but this one does not
      if (Math.hypot(pc[0] - ex, pc[1] - ey) > o.outlier * torso && neighbours < o.outlier * torso) drop.push([i, k]);
    }
  }
  for (const [i, k] of drop) chosen[i]![k * 3 + 2] = 0;
}

interface Filled {
  time: number;
  i: number;
  points: number[] | null;
  interpolated: boolean;
}

/** Fills missing samples and missing joints by moving the body along between known poses. */
function fillGaps(chosen: (number[] | null)[], times: number[], o: TrackOptions): Filled[] {
  const out: Filled[] = chosen.map((p, i) => ({ time: times[i], i, points: p, interpolated: false }));
  const known = out.map((f, i) => (f.points ? i : -1)).filter((i) => i >= 0);
  for (let q = 0; q + 1 < known.length; q++) {
    const a = known[q];
    const b = known[q + 1];
    if (b - a < 2 || times[b] - times[a] > o.maxGap) continue;
    for (let i = a + 1; i < b; i++) {
      const f = (times[i] - times[a]) / (times[b] - times[a]);
      out[i] = { time: times[i], i, points: interpolatePose(out[a].points!, out[b].points!, f, o.minVisibility), interpolated: true };
    }
  }
  // Single joints missing between known positions of the same joint
  for (let k = 0; k < N; k++) {
    let lastSeen = -1;
    for (let i = 0; i < out.length; i++) {
      const p = out[i].points;
      if (!p) continue;
      if (p[k * 3 + 2] >= o.minVisibility) {
        if (lastSeen >= 0 && i - lastSeen > 1 && times[i] - times[lastSeen] <= o.maxGap) {
          const pa = out[lastSeen].points!;
          for (let j = lastSeen + 1; j < i; j++) {
            const pj = out[j].points;
            if (!pj) continue;
            const f = (times[j] - times[lastSeen]) / (times[i] - times[lastSeen]);
            pj[k * 3] = pa[k * 3] + (p[k * 3] - pa[k * 3]) * f;
            pj[k * 3 + 1] = pa[k * 3 + 1] + (p[k * 3 + 1] - pa[k * 3 + 1]) * f;
            pj[k * 3 + 2] = Math.min(pa[k * 3 + 2], p[k * 3 + 2]) * 0.8;
          }
        }
        lastSeen = i;
      }
    }
  }
  return out;
}

/**
 * Pose between a and b at fraction f: hip centre and torso angle are interpolated (the angle the
 * short way round, so a turning body keeps turning), joints keep their shape relative to the torso.
 */
export function interpolatePose(a: number[], b: number[], f: number, minVis = 0.3): number[] {
  const ba = body(a, minVis);
  const bb = body(b, minVis);
  const out = new Array<number>(a.length).fill(0);
  if (!ba.centre || !bb.centre || !Number.isFinite(ba.angle) || !Number.isFinite(bb.angle)) {
    for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * f;
    for (let k = 0; k < N; k++) out[k * 3 + 2] = Math.min(a[k * 3 + 2], b[k * 3 + 2]) * 0.8;
    return out;
  }
  let turn = bb.angle - ba.angle;
  turn = ((turn + 540) % 360) - 180;
  const angle = ba.angle + turn * f;
  const cx = ba.centre[0] + (bb.centre[0] - ba.centre[0]) * f;
  const cy = ba.centre[1] + (bb.centre[1] - ba.centre[1]) * f;
  const scaleA = ba.torso;
  const scaleB = bb.torso;
  const scale = scaleA + (scaleB - scaleA) * f;
  const rel = (pts: number[], bd: Body, k: number): Pt => {
    // Joint in torso coordinates: rotate by -angle around the centre, divide by torso length
    const r = (-bd.angle * Math.PI) / 180;
    const dx = pts[k * 3] - bd.centre![0];
    const dy = pts[k * 3 + 1] - bd.centre![1];
    return [(dx * Math.cos(r) - dy * Math.sin(r)) / bd.torso, (dx * Math.sin(r) + dy * Math.cos(r)) / bd.torso];
  };
  const r = (angle * Math.PI) / 180;
  for (let k = 0; k < N; k++) {
    const ra = rel(a, ba, k);
    const rb = rel(b, bb, k);
    const ux = (ra[0] + (rb[0] - ra[0]) * f) * scale;
    const uy = (ra[1] + (rb[1] - ra[1]) * f) * scale;
    out[k * 3] = cx + ux * Math.cos(r) - uy * Math.sin(r);
    out[k * 3 + 1] = cy + ux * Math.sin(r) + uy * Math.cos(r);
    out[k * 3 + 2] = Math.min(a[k * 3 + 2], b[k * 3 + 2]) * 0.8;
  }
  return out;
}

/** [1, 2, 1] / 4 smoothing of each joint over neighbouring samples less than 0.15 s apart. */
function smooth(frames: Filled[], o: TrackOptions) {
  const copy = frames.map((f) => (f.points ? f.points.slice() : null));
  for (let i = 1; i + 1 < frames.length; i++) {
    const a = copy[i - 1];
    const c = copy[i];
    const b = copy[i + 1];
    if (!a || !b || !c) continue;
    if (frames[i + 1].time - frames[i - 1].time > 0.3) continue;
    for (let k = 0; k < N; k++) {
      if (a[k * 3 + 2] < o.minVisibility || b[k * 3 + 2] < o.minVisibility || c[k * 3 + 2] < o.minVisibility) continue;
      for (const d of [0, 1]) frames[i].points![k * 3 + d] = (a[k * 3 + d] + 2 * c[k * 3 + d] + b[k * 3 + d]) / 4;
    }
  }
}

function round(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}
