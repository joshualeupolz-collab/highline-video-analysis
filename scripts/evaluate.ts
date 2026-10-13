/**
 * Compares automatic cut points with hand-marked ones for every `videos/*.bdc.json`
 * that has a matching video file next to it.
 *
 *   npm run evaluate            # all marked videos (motion analysis via ffmpeg)
 *   npm run evaluate -- 0.5     # with a different tolerance in seconds (default 0.3)
 *   npm run evaluate -- --from out/   # use <name>.auto.json from scripts/browser-eval.mjs (motion + pose)
 *   DETECT_OPTS='{"plateauFraction":0}' npm run evaluate   # try other detector settings
 *   (also MOTION_OPTS='{...}' and WIDTH=320)
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectCutPoints, evaluateCutPoints, MotionTracker } from "../src/analysis/core";
import type { FrameMotion } from "../src/analysis/core";
import { grayFrames } from "./frames-node";

const dir = "videos";
const args = process.argv.slice(2);
const fromIndex = args.indexOf("--from");
const from = fromIndex >= 0 ? args.splice(fromIndex, 2)[1] : null;
const tolerance = Number(args[0] ?? 0.3);
const marked = readdirSync(dir).filter((f) => f.endsWith(".bdc.json")).sort();
if (!marked.length) {
  console.log(`No *.bdc.json files in ${dir}/ yet. Mark videos on the test page and save them there.`);
  process.exit(0);
}

async function analyzeWithFfmpeg(base: string) {
  const video = [".mp4", ".webm", ".mov"].map((e) => join(dir, base + e)).find(existsSync);
  if (!video) return null;
  const tracker = new MotionTracker(JSON.parse(process.env.MOTION_OPTS ?? "{}"));
  const motions: FrameMotion[] = [];
  let duration = 0;
  for await (const frame of grayFrames(video, 15, Number(process.env.WIDTH ?? 160))) {
    duration = frame.time;
    const m = tracker.push(frame);
    if (m) motions.push(m);
  }
  return detectCutPoints(motions, duration, JSON.parse(process.env.DETECT_OPTS ?? "{}"));
}

let truthTotal = 0;
let matchTotal = 0;
let predTotal = 0;
for (const f of marked) {
  const marks = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const base = f.replace(/\.bdc\.json$/, "");
  let result: { cutPoints: { time: number }[] } | null;
  if (from) {
    const file = join(from, `${base}.auto.json`);
    result = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  } else result = await analyzeWithFfmpeg(base);
  if (!result) {
    console.log(`${base}: no ${from ? "analysis file" : "video"} found, skipped`);
    continue;
  }
  const ev = evaluateCutPoints(marks.bdc, result.cutPoints.map((c) => c.time), tolerance);
  truthTotal += marks.bdc.length;
  matchTotal += ev.matches.length;
  predTotal += result.cutPoints.length;
  const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : "-");
  console.log(
    `${base.padEnd(12)} found ${String(ev.matches.length).padStart(2)}/${String(marks.bdc.length).padEnd(2)} (${pct(ev.recall).padStart(4)})` +
      `  precision ${pct(ev.precision).padStart(4)}  mean error ${Number.isFinite(ev.meanAbsError) ? ev.meanAbsError.toFixed(2) : "-"} s` +
      (ev.missed.length ? `  missed [${ev.missed.map((x: number) => x.toFixed(2)).join(" ")}]` : "") +
      (ev.extra.length ? `  extra [${ev.extra.map((x: number) => x.toFixed(2)).join(" ")}]` : ""),
  );
}
console.log(
  `\nTotal: ${matchTotal}/${truthTotal} hand-marked BDCs found within ±${tolerance} s ` +
    `(${Math.round((100 * matchTotal) / Math.max(1, truthTotal))}%), ` +
    `${Math.round((100 * matchTotal) / Math.max(1, predTotal))}% of suggestions correct. Goal: ≥ 90%.`,
);
