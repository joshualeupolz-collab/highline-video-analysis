# highline-video-analysis

Prototype: find the **bottom dead center (BDC)** of every bounce in highline freestyle videos,
in the browser. Background and requirements: [CLAUDE.md](CLAUDE.md).

## Test page

Online: <https://joshualeupolz-collab.github.io/highline-video-analysis/> (built from `main` by
`.github/workflows/pages.yml`; needs Settings → Pages → Source: "GitHub Actions" once).


```sh
npm install
npm run dev        # open the printed URL (also works from a phone in the same Wi-Fi)
npm run build      # dist/ plus a single self-contained dist/bdc-test-bench.html
```

1. **Open videos / JSON…** – pick one or more videos (and their `.bdc.json` files, if any).
   Nothing is uploaded; everything stays in the browser.
2. **Run automatic analysis** – orange triangles are the suggested BDCs, the blue curve is the
   estimated athlete height (lower on the chart = lower athlete), grey is foreground motion.
3. Mark the true BDCs yourself: step with ← / → (one frame) or Shift+← / → (0.5 s), press **M** at
   the lowest point. **C** marks a cut (change of shot), **Del** removes the nearest mark, drag green
   marks to move them. Tick **Hide automatic points** to mark without seeing the suggestions.
4. **Save my marks** downloads `video-XX.bdc.json`; put it into `videos/`.
   The table at the bottom shows found / missed / extra points (±0.3 s).

Marks are also kept in the browser's local storage until you clear them. **Show my marks as text**
gives the same JSON for copying (e.g. into a chat).

## Command line

```sh
npm test                               # unit tests (Vitest)
npm run analyze -- videos/video-05.mp4 # writes videos/video-05.auto.json (needs ffmpeg)
npm run evaluate                       # compares all videos/*.bdc.json with the automatic result
```

## Code

- `src/analysis/` – the analysis module (no UI, no dependencies). `analyze(file)` is the browser
  entry; `core.ts` exports the DOM-free parts.
- `src/testpage/` – the test page.
- `scripts/` – Node helpers (ffmpeg frame decoding, batch analysis, evaluation, single-file build).

MIT licence.
