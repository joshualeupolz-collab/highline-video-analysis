import { defineConfig } from "vitest/config";

// `base: "./"` keeps the build working from any sub-path (GitHub Pages, a file share, ...).
export default defineConfig({
  base: "./",
  server: { host: true },
  // One script file, so dist/bdc-test-bench.html can inline everything.
  build: { rollupOptions: { output: { inlineDynamicImports: true } } },
  test: { include: ["test/**/*.test.ts"] },
});
