import { defineConfig } from "vitest/config";

// `base: "./"` keeps the build working from any sub-path (GitHub Pages, a file share, ...).
export default defineConfig({
  base: "./",
  server: { host: true },
  test: { include: ["test/**/*.test.ts"] },
});
