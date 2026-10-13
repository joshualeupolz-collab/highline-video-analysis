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
