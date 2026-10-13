/**
 * Runs the built test page's analysis (motion + pose) in headless Chromium over a folder of videos
 * and writes <name>.auto.json files, for `npm run evaluate -- --from <out>`.
 *
 *   npm run build
 *   node scripts/browser-eval.mjs <videoDir> <outDir> [model=full] [names...]
 *
 * Pose runs with the CPU delegate here (headless Chromium has no real GPU).
 * Needs Playwright with a Chromium (not a project dependency). Playwright's Chromium cannot decode
 * H.264, so convert MP4s to WebM first, e.g.
 *   ffmpeg -i videos/video-01.mp4 -c:v libvpx-vp9 -crf 30 -b:v 0 -an webm/video-01.webm
 */
import { createServer } from "node:http";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const [videoDir, outDir, model = "full", ...only] = process.argv.slice(2);
if (!videoDir || !outDir) {
  console.error("usage: node scripts/browser-eval.mjs <videoDir> <outDir> [model] [names...]");
  process.exit(1);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
mkdirSync(outDir, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".webm": "video/webm", ".mp4": "video/mp4" };
const server = createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const file = url.startsWith("/videos/") ? join(resolve(videoDir), url.slice(8)) : join(resolve("dist"), url === "/" ? "index.html" : url);
  if (!existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}).listen(0);
const port = server.address().port;

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("pageerror:", e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.bdcBench);

const names = readdirSync(videoDir).filter((f) => /\.(webm|mp4)$/.test(f) && (!only.length || only.some((o) => f.includes(o)))).sort();
for (const name of names) {
  const started = Date.now();
  const result = await page.evaluate(
    async ([url, model]) => {
      const blob = await (await fetch(url)).blob();
      return await window.bdcBench.analyze(blob, { pose: model === "none" ? false : { model, delegate: "CPU" } });
    },
    [`/videos/${name}`, model],
  );
  const out = join(outDir, name.replace(/\.[^.]+$/, ".auto.json"));
  writeFileSync(out, JSON.stringify(result));
  const pose = result.pose ? `pose ${result.pose.track.frames.length}/${result.pose.track.sampled}` : "no pose";
  console.log(`${name}: ${result.cutPoints.length} BDCs, ${pose}, ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
await browser.close();
server.close();
