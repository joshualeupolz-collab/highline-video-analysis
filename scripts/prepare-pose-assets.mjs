// Copies the MediaPipe wasm files and downloads the pose models into public/mediapipe/,
// so dev server and build serve them next to the page (no CDN needed at runtime).
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = "public/mediapipe";
mkdirSync(out, { recursive: true });
const wasm = "node_modules/@mediapipe/tasks-vision/wasm";
for (const f of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  copyFileSync(join(wasm, f), join(out, f));
}
for (const m of (process.env.POSE_MODELS ?? "lite,full").split(",")) {
  const file = join(out, `pose_landmarker_${m}.task`);
  if (existsSync(file)) continue;
  const url = `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${file}`);
}
