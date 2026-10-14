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
- **Approach B implemented (2026-10-13)** in `src/analysis/pose/`, MediaPipe Pose Landmarker
  (`@mediapipe/tasks-vision` 1.0.1, "full" model, IMAGE mode, loaded lazily):
  - Runs on a 256 px square crop around the athlete: from the previous pose (padding 1.8×), else from
    the motion focus of approach A, else the whole frame. Two attempts per sample at most.
  - Second pass over the video after approach A, ~8 pose samples per video second; playback speed
    adapts to the model's speed. Wasm + model (~20 MB) come from `./mediapipe/` (copied/downloaded
    by `npm run assets`) or the CDNs.
  - Output per sample: 17 keypoints (nose, shoulders, elbows, wrists, hips, knees, ankles, heels,
    toes) in frame-width units with visibility (`PoseTrack`). Derived: knee/hip angles, torso tilt,
    camera-corrected feet height (`features.ts`, `camera.ts`), per-bounce profile (`profile.ts`:
    knee at the BDC, smallest knee/hip angle, max tilt, unwrapped rotation, time upside down, arms up).
  - Test page: skeleton overlay, pose chart (knee / tilt / feet), "Body per bounce" table, trick
    name per bounce saved in `.bdc.json` as `tricks: [{start, end, name}]` – training labels for
    later trick recognition.
  - **Finding:** in the browser, approach A alone is already within ~0.1 s of the hand marks
    (mean abs error 0.11 / 0.13 / 0.10 s on videos 01 / 04 / 05) – about the precision of the hand
    marks themselves. Moving the BDC to the lowest-feet plateau made it worse (0.21 s on video-01);
    moving it to the moment the knees straighten (the owner marks exactly that in video-01) was
    equal, not better. Averaging the motion time with the knee time (`refine.mode` "blend", the
    default) was slightly better than either on videos 01 and 05 (e.g. 05: 0.077 → 0.057 s), so the
    pose now nudges the BDC halfway towards the moment the knees straighten, where it sees that.
  - **Run-to-run noise:** browser frame sampling is irregular, so results vary between runs
    (motion only, several runs each: video-01 10–15/15, video-04 13–16/17, video-05 always 12/12;
    2× instead of 4× analysis speed was not clearly better). A second full run of video-01 gave
    10/15 instead of 15/15 (bottom plateau is flat in that telephoto
    clip; small signal changes move the peak by up to 0.6 s). Simulated browser sampling (ffmpeg at
    30 fps with random drops, 6 seeds) gives ~85 % over videos 01/04/05; more smoothing
    (`smoothSeconds` 0.3) or `plateauFraction` 0.4 gained only ~1 % there and lost on the
    ffmpeg run, so the defaults stay.
  - Pose found (share of samples): 01 100 %, 02 90 %, 03 91 %, 04 35 % (tiny athlete), 05 99 %,
    06 67 %, 07 98 %, 08 100 %.
  - Speed (headless desktop Chromium, CPU delegate): ~1.3–1.9 s of analysis per second of video with
    pose (e.g. 36 s video in 50 s, 73 s video in 95 s). Phones use the GPU delegate; not measured yet.
- **Round 2 of approach B (owner feedback 2026-10-13):**
  - Skeleton flipped 180° (head at the knees) in video-08 at 12.8–13.2 s while the athlete hung
    upright with arms up. Fixes: the crop is turned so the previous torso points up (also helps in
    flips), and a pose that turns faster than 400°/s (+40° slack) since the last accepted pose is
    rejected; then a wider crop and the motion crop are tried, else the sample is a miss.
  - 15 pose samples per second by default (selectable 8 / 15 / 30); misses are stored
    (`PoseTrack.missed`) so "pose found" per bounce is found / (found + missed).
  - Owner prefers the hip-to-feet distance over the knee angle: `legSpan` and `legExtension`
    (% of the median span with both knees ≥ 165°). Shown in the chart and the bounce table; the
    "blend" refinement now uses it (legs straight = 95 % after < 85 %; same accuracy as the knee).
  - Test page: own control bar instead of the native video controls (no play button over the
    athlete), full screen of the whole stage (video + skeleton + buttons, CSS fallback on iPhone),
    key F.
  - Line (experimental, `line.ts`): rays from the contact point (feet when upright, hands) scored
    for a thin straight ridge of one polarity, best pair ≥ 130° apart, preferring directions close
    to the previous estimate. Works on clear frames (video-08 standing), still locks onto arms or
    branches sometimes; drawn as a dashed line. A Hough search for straight lines left/right of
    the athlete was tried first and found brick joints and branches instead.
- **Round 3 of approach B – prediction and offline tracking (owner feedback: round 2 looked worse;
  use prediction, continuity, look before and after):**
  - Plausibility metrics without ground truth (scratch script, see the session): torso flips vs.
    both neighbours, poses with ≥ 2 bones off by > ×1.6 / < ×0.6 of their median, joints > 0.5
    torso lengths off the line between their neighbours, line contact switches and direction jumps.
  - Pose (`track.ts`): during the pass the crop is placed where the body is predicted to be
    (constant speed and turn rate from the last picks, ≤ 700°/s); a second, upright or wider crop
    only runs when the first result does not fit the prediction. All candidates (plus left/right
    swapped versions) go to an offline Viterbi that minimises joint jumps beyond 6 torso lengths/s,
    turning beyond 500°/s, bone length changes and low visibility; then single-joint outliers are
    dropped, gaps ≤ 0.6 s are filled by moving the hip centre and *turning* the torso on (limbs keep
    their shape), and a [1,2,1] smoothing removes jitter. Result on videos 01/05/07/08: torso flips
    1–10 → 0, joint spikes 27–154 → 0–1 per video; skeletons checked by eye on 05 and 08 incl. the
    hang and backflip in 08 at 12.6–14.2 s. Time with pose ≈ 2.5–3× video length on headless CPU.
  - Line (`trackLine` in `line.ts`): ray scores per sample from the feet (and the hands only when
    the body is not upright), directions along the athlete's own limbs and near-vertical
    directions (leash, rope to a backup line) masked; offline Viterbi over direction, kink and
    contact with slow changes, a high cost for switching feet ↔ hands and a V-shape prior.
    No more direction jumps; still right only about half the time where it is drawn (video-05's
    wide webbing and brick wall are hard). "Show line" is off by default.
- **Round 4 (owner feedback: first 3 s of video-08 without pose; tuck flip at 16.2–18 s messy;
  sample sparsely when calm, densely when fast):**
  - Missing start: on the GPU delegate the first inference (shader compilation) takes seconds while
    the video kept playing, so everything until then was skipped (reproduced with the GPU path in
    headless Chromium: 3 samples in 6 s). Fixes: the model is warmed up before playback, and the
    pose pass pauses the video while it works (`playFrames({ pauseWhileWorking })`), so no wanted
    sample is lost however slow the device. Now ~10 samples/s from 0.03 s on the GPU path too.
  - Adaptive sampling: 10 poses/s in calm phases, every frame (30/s) for 0.4 s after a turn faster
    than 200°/s, a centre speed above 6 torso lengths/s, or an unclear detection (second crop
    needed / nothing found). Time for videos 01/05/08 with pose: 105/99/70 s (was 194/151/125 s
    with two crops at 15/s), no torso flips or joint spikes.
  - Not tracking yet: search crops of 30/45/70 % of the frame around the motion focus (rotating
    sizes), then the full frame.
  - Offline tracker allows 900°/s turning (tuck flips are that fast). The tuck flip in video-08 at
    16.2–18 s (motion blur, body folded) is still partly wrong – close to what MediaPipe can do.
- **Round 5 (owner feedback 2026-10-14: skeleton sometimes one frame off; line stays at the feet
  when the hands take over; wanted: stick figure without the video):**
  - Checked with a frame-numbered test video (each frame encodes its index): with rVFC playback
    the frame drawn can be newer than the reported `mediaTime` – at 4× ~15 % of samples were two
    frames late, at 8× more; at 2× and in the pose pass at ≤ 1× (pause while working) every
    sample matched. So the motion pass now defaults to 2× and the pose pass never plays faster
    than 1× between samples.
  - Display: the skeleton is drawn for the frame the browser actually presents (rVFC on the visible
    video), not for the seek target; frame stepping lands in the middle of a frame; `poseAt` uses
    the sample of exactly that frame or interpolates between the neighbours. Checked: 8 steps at
    13.0 s in video-08, pose time = shown frame every time.
  - Offline tracker: impossible turns cost much more (`turnWeight` 6, excess / 45°), so a run of
    flipped skeletons (video-08 13.0–13.4 s, hanging upright with arms up) is dropped and filled
    from both sides instead of being kept.
  - Line: hands are a contact candidate also when both wrists are above the head (hanging from
    the line / reaching for it), so the line can move from the feet to the hands.
  - Test page: "Show video" / ◐ / key V hides the picture and leaves the stick figure (and line).
  - Note on the bone-length metric: many "bad bone" poses in video-05 are correct, the limbs are
    just foreshortened (body turned towards the camera); real errors there are few (e.g. 8.2 s,
    25.6 s).
- **Privacy (decide before the app uses it):** MediaPipe Tasks sends usage statistics (task type,
  timings; no images) to `https://odml.pa.googleapis.com/v1/log` and has no switch to turn that off.
- Model files: `.task` from `./mediapipe/`, else the same model as base64 JSON
  (`./mediapipe/pose_landmarker_<m>.json`, for hosts that do not serve `.task`, e.g. the claude.ai
  artifact of the test page), else Google's model CDN.
- **Next:** measure speed on phones; collect trick names per bounce; use pose to drop false BDCs
  (needs more marked videos with tricks at the top); line detection for tiny athletes.
