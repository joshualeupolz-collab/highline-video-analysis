/**
 * Runs the analysis on local video files with the system ffmpeg and writes
 * `<video>.auto.json` next to each video (cut points + signals).
 *
 *   npm run analyze -- videos/*.mp4
 */
import { writeFileSync } from "node:fs";
import { detectCutPoints, MotionTracker } from "../src/analysis/core";
import type { FrameMotion } from "../src/analysis/core";
import { grayFrames } from "./frames-node";

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: npm run analyze -- <video> [...]");
  process.exit(1);
}
for (const file of files) {
  const started = Date.now();
  const tracker = new MotionTracker();
  const motions: FrameMotion[] = [];
  let duration = 0;
  for await (const frame of grayFrames(file, 15, 160)) {
    duration = frame.time;
    const m = tracker.push(frame);
    if (m) motions.push(m);
  }
  const result = detectCutPoints(motions, duration);
  const out = file.replace(/\.[^.]+$/, ".auto.json");
  writeFileSync(out, JSON.stringify(result));
  const cps = result.cutPoints.map((c) => c.time.toFixed(2)).join(" ");
  console.log(`${file}: period ${result.period.toFixed(2)} s, ${result.cutPoints.length} BDCs [${cps}] (${Date.now() - started} ms)`);
}
