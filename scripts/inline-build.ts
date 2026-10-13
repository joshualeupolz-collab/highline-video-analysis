/**
 * Turns dist/ into one self-contained HTML file (dist/bdc-test-bench.html) by inlining the
 * built script and stylesheet. Handy for opening the test page without a server.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dist = "dist";
let html = readFileSync(join(dist, "index.html"), "utf8");
html = html.replace(/<script type="module" crossorigin src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, p) => {
  const js = readFileSync(join(dist, p), "utf8").replace(/<\/script/gi, "<\\/script");
  return `<script type="module">${js}</script>`;
});
html = html.replace(/<link rel="stylesheet" crossorigin href="\.\/(assets\/[^"]+\.css)">/, (_, p) => {
  return `<style>${readFileSync(join(dist, p), "utf8")}</style>`;
});
if (/src="\.\/assets|href="\.\/assets/.test(html)) throw new Error("Something was not inlined");
writeFileSync(join(dist, "bdc-test-bench.html"), html);
console.log("wrote dist/bdc-test-bench.html");
