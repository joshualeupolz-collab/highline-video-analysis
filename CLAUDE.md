# Video analysis prototype – brief for a separate project

As of 2026-10-13. Decided by the owner: cut points, auto-cut and body pose detection are developed
**in a separate repository and session first**, without the app's context, and merged into the app
later. This file is everything such a session needs. Copy it into the new repository as
`CLAUDE.md` (or `README.md`) and start there.

---

## What it is for

The app (*Highline Freestyle Battles*) records highline freestyle attempts on phones: an athlete
bounces on a highline and does tricks on the way up and at the top. A video shows one attempt
(a combo of several bounces, 15–60 s).

Wanted, in this order:

1. **Cut points:** the time of the **bottom dead center (BDC)** of every bounce. Between two cut
   points is one bounce/trick. Accuracy ±0.3 s is enough; the user confirms or drags them.
2. **Auto-cut:** split the video into one clip per bounce from these points (later, on the server).
3. **Body pose:** keypoints (head, shoulders, hips, elbows, wrists, knees, ankles) per frame, as raw
   material for later trick recognition (rotations, grabs, body position).
4. Later: a rule against misuse – at least 2 seconds of video before the first bounce (owner,
   2026-10-13).

## Constraints from the app (keep them, then merging is easy)

- The app is a **web app (PWA)** in TypeScript (React + Vite), running in the phone's browser
  (Android Chrome, iPhone Safari). The analysis must run **in the browser on the phone, after
  recording**, not in real time: a 60 s video should take seconds, not minutes.
- No server costs: the app runs on Cloudflare's free tier. Heavy work can later run in a GitHub
  Actions job, but the first goal is on-device.
- Input: MP4 (H.264, iPhone/Android) or WebM (VP8/VP9, Android), 480p–1080p, about one keyframe
  per second. Typical filming: camera about **30 m away**, fixed or only **tilting/panning** to
  follow the athlete; no drone shots.
- Output the app can use: a list of cut-point timestamps in seconds, plus (optional) per-frame
  signals (motion energy, pose keypoints) as a few KB of JSON per video.
- Libraries: prefer small ones. Candidates: plain canvas/WebGL, OpenCV.js, MediaPipe Pose
  (Tasks Vision, WASM). Avoid ffmpeg.wasm (~30 MB, slow on phones).
- Code and docs in English. Tests with Vitest. MIT licence like the app.

## Domain facts

- Bounces are nearly periodic: one every **3–4 s** on a given line.
- At the bottom the athlete is almost still for up to ~1 s, legs pushed straight; the line is
  momentarily at rest too.
- Rotations, arm movements and tricks happen on the way up and at the top. The top is also a
  turning point with low vertical speed – it must not be mistaken for the bottom.

## Suggested approaches (from the app's design notes)

**A – foreground vs. background motion (try first, cheap):** per frame on a downscaled grayscale
image (160–320 px, 10–15 fps): estimate the global camera shift (phase correlation or tracking
on the borders), compensate it, measure the remaining motion (frame difference or optical flow).
Long low plateaus of this signal are BDC candidates.

**B – body pose (MediaPipe):** keypoints on every 2nd–5th frame; speed of keypoints relative to
each other, normalised by shoulder width; knee angle close to 180° at the bottom. Tells top and
bottom apart.

**Combine:** estimate the bounce period by autocorrelation (expect 3–4 s); find one confident BDC
(low motion + straight legs), predict the next ones at t0 + n·T and refine locally (±0.5·T). If
nothing is confident, suggest evenly spaced markers or none.

## Test plan

1. A **test page** (static, runs locally and on GitHub Pages): pick a video file, run the
   analysis, show the signals as a chart and the suggested cut points on a timeline; mark the
   true BDCs by hand once and save them as JSON next to the video.
2. A **test set**: 10–20 videos (the owner has videos, e.g. from Instagram – fine for testing,
   not for publishing): fixed vs. tilting camera, different lines, light, athlete size, combos
   with pauses and falls.
3. A script that compares suggestions with the hand-marked BDCs. Success: at least ~90 % of
   cut points within ±0.3 s on clean competition-style footage.
4. Then on phones: speed on an older Android phone and an iPhone.

## Merging into the app later

The app stores "one video + a list of cut points" and has a cutting module without re-encoding
(`apps/web/src/video/trim.ts`, own MP4/WebM code). The analysis should become a pure module
(`analyze(videoFile) → { cutPoints, signals }`) that the app calls after recording, on the
"Cut and upload" screen. Keep it free of UI and of the app's data model.

---

## Status in this repository (2026-10-13)

- Test videos are in `videos/` (`video-01.mp4` … `video-08.mp4`, see `videos/README.md`).
  Hand-marked BDCs go next to them as `video-XX.bdc.json`.
- **Test page** (`index.html`, `src/testpage/`): open videos, run the analysis, see signals and
  suggested cut points on a timeline, mark true BDCs by hand (keys M / C / Del / ← →), save them as
  JSON, and see found / missed / extra points against the hand marks. `npm run build` also writes a
  single self-contained `dist/bdc-test-bench.html`.
- **Approach A implemented** (`src/analysis/`, pure TS, no dependencies):
  - `motion.ts`: per frame (160 px gray, ~15 fps) global shift by phase correlation
    (`phaseCorrelation.ts`, `fft.ts`), residual motion after compensating it, centroid of the residual
    motion, hard-cut detection.
  - `detect.ts`: per shot, athlete height ≈ foreground centroid y − accumulated camera tilt,
    smoothed and detrended; bounce period by autocorrelation; BDCs = prominent maxima (athlete lowest).
  - `analyze.ts` / `videoFrames.ts`: browser entry `analyze(file) → { cutPoints, period, signals }`
    (plays the video muted at 2–8× and grabs frames with `requestVideoFrameCallback`).
  - `scripts/analyze-node.ts`, `scripts/evaluate.ts`: same core in Node via the system ffmpeg.
- **Finding:** in the test videos the camera follows the athlete, so the accumulated vertical camera
  shift is the strongest signal (it is the athlete's height and tells top from bottom). Pure
  foreground motion energy, as first suggested, is low at both top and bottom and was not
  discriminative; it is kept as a chart signal only.
- **Known weak spots:** tight telephoto shots where the athlete fills the frame (video-01; phase
  correlation then partly tracks the athlete), fixed camera with a small athlete (video-04), standing
  pauses without bounces. Browser sampling timestamps vary a little between runs, so results can
  differ by a point or two.
- **Results so far** (`npm run evaluate`): video-01 (hardest clip, tight telephoto, one cut)
  13/15 within ±0.3 s, 15/15 within ±0.5 s. Tuning from it: the cut point is the centre of the
  bottom plateau (`plateauFraction` 0.3), not its highest sample, which was ~0.4 s late;
  points closer than 0.65 periods are merged; no points within 0.4 s of a hard cut. Only one video
  is hand-marked so far, so these defaults may still be overfitted.
- **Second round (video-04 marked, fixed camera, tiny athlete, line clearly visible):**
  the height now comes from `fgYLow` – the row above which 85 % of the residual motion lies,
  measured only inside a "focus band" (25 % of the frame width) that follows where motion keeps
  happening (column heat map with decay). That is roughly the lowest moving part of the athlete:
  feet / line when standing. video-01 14/15, video-04 12/17 (±0.3 s); 26/32 = 81 % overall.
  Remaining video-04 misses are where the athlete rotates around the line or lies down at the top
  (the body is then below the line), and one camera pan (12–15 s).
  Tried and rejected for now: 320 px analysis width (not better), `lineY` = motion in bands
  beside the athlete, i.e. the line itself (worse: at 160 px the line is sub-pixel thin and in
  telephoto shots hardly visible; kept as an experimental `heightSource`). Results are sensitive to
  `lowQuantile` (0.75 and 0.9 are clearly worse), so more marked videos are needed.
- **Third round (video-05 marked, camera follows, no retuning):** 12/12 within ±0.3 s with the
  `fgYLow` defaults (the old centroid `fgY` would give 10/12) – the first check on a video the
  settings were not tuned on. Overall 38/44 = 86 %.
- **Owner feedback (2026-10-13):** ±0.3 s is strict; the owner also finds the exact BDC hard to
  pick when there is sideways motion. The measured point is the centroid of all residual motion
  (body + arms + line) plus camera tilt, not a specific body part; the owner would prefer the line
  contact (feet, or hands when hanging) – that needs pose detection (approach B).
- **Next:** hand-mark the test videos, run `npm run evaluate`, tune; then approach B (pose) for the
  hard cases and the "predict t0 + n·T and refine" step.
