import { MIN_VISIBILITY } from "../analysis/pose/features";
import { interpolatePose } from "../analysis/pose/track";
import { KEYPOINTS, type PoseFrame, type PoseTrack } from "../analysis/pose/types";

const i = Object.fromEntries(KEYPOINTS.map((k, n) => [k, n])) as Record<(typeof KEYPOINTS)[number], number>;

/** Bones as [from, to, side]: side 0 = centre, 1 = left, 2 = right. */
const BONES: [number, number, 0 | 1 | 2][] = [
  [i.leftShoulder, i.rightShoulder, 0],
  [i.leftHip, i.rightHip, 0],
  [i.leftShoulder, i.leftHip, 1],
  [i.rightShoulder, i.rightHip, 2],
  [i.leftShoulder, i.leftElbow, 1],
  [i.leftElbow, i.leftWrist, 1],
  [i.rightShoulder, i.rightElbow, 2],
  [i.rightElbow, i.rightWrist, 2],
  [i.leftHip, i.leftKnee, 1],
  [i.leftKnee, i.leftAnkle, 1],
  [i.rightHip, i.rightKnee, 2],
  [i.rightKnee, i.rightAnkle, 2],
  [i.leftAnkle, i.leftHeel, 1],
  [i.leftHeel, i.leftToe, 1],
  [i.leftAnkle, i.leftToe, 1],
  [i.rightAnkle, i.rightHeel, 2],
  [i.rightHeel, i.rightToe, 2],
  [i.rightAnkle, i.rightToe, 2],
];

/**
 * The pose for the video frame at time `t`: the sample of exactly that frame if there is one,
 * else interpolated between the samples before and after (each at most `maxGap` seconds away).
 */
export function poseAt(track: PoseTrack, t: number, frameDuration = 1 / 30, maxGap = 0.25): PoseFrame | null {
  const frames = track.frames;
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  const after = frames[lo];
  const before = lo > 0 ? frames[lo - 1] : null;
  for (const f of [after, before]) if (f && Math.abs(f.time - t) < frameDuration / 2) return f;
  if (before && after && after.time > t && t - before.time <= maxGap && after.time - t <= maxGap) {
    const f = (t - before.time) / (after.time - before.time);
    return { time: t, points: interpolatePose(before.points, after.points, f), source: "interpolated" };
  }
  return null;
}

/** Draws `pose` over the displayed video picture (object-fit: contain). */
export function drawSkeleton(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  pose: PoseFrame | null,
  show: { skeleton: boolean; line: boolean } = { skeleton: true, line: true },
) {
  const dpr = window.devicePixelRatio || 1;
  const vw = video.clientWidth;
  const vh = video.clientHeight;
  canvas.style.left = `${video.offsetLeft}px`;
  canvas.style.top = `${video.offsetTop}px`;
  canvas.style.width = `${vw}px`;
  canvas.style.height = `${vh}px`;
  if (canvas.width !== Math.round(vw * dpr) || canvas.height !== Math.round(vh * dpr)) {
    canvas.width = Math.round(vw * dpr);
    canvas.height = Math.round(vh * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vw, vh);
  if (!pose || !video.videoWidth) return;
  const k = Math.min(vw / video.videoWidth, vh / video.videoHeight);
  const ox = (vw - video.videoWidth * k) / 2;
  const oy = (vh - video.videoHeight * k) / 2;
  // Pose coordinates are in frame-width units
  const px = (n: number): [number, number] | null =>
    pose.points[n * 3 + 2] >= MIN_VISIBILITY
      ? [ox + pose.points[n * 3] * video.videoWidth * k, oy + pose.points[n * 3 + 1] * video.videoWidth * k]
      : null;
  const style = getComputedStyle(document.documentElement);
  const colors = ["#ffffff", style.getPropertyValue("--left").trim() || "#0ea5e9", style.getPropertyValue("--right").trim() || "#f43f5e"];
  ctx.lineCap = "round";
  // Poses filled in between detections are drawn fainter
  ctx.globalAlpha = pose.source === "interpolated" ? 0.55 : 1;
  for (const [a, b, side] of show.skeleton ? BONES : []) {
    const pa = px(a);
    const pb = px(b);
    if (!pa || !pb) continue;
    ctx.strokeStyle = "rgba(0,0,0,0.55)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(...pa);
    ctx.lineTo(...pb);
    ctx.stroke();
    ctx.strokeStyle = colors[side];
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  if (pose.line && show.line) {
    // Experimental line: two rays from the contact point
    const l = pose.line;
    const W = video.videoWidth * k;
    const c = [ox + l.contact[0] * W, oy + l.contact[1] * W];
    ctx.setLineDash([8, 5]);
    for (const a of l.angles) {
      const ux = Math.cos((a * Math.PI) / 180);
      const uy = Math.sin((a * Math.PI) / 180);
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(c[0] + ux * l.start * W * 0.3, c[1] + uy * l.start * W * 0.3);
      ctx.lineTo(c[0] + ux * (l.start + l.reach) * W, c[1] + uy * (l.start + l.reach) * W);
      ctx.stroke();
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
  const head = px(i.nose);
  if (head && show.skeleton) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(head[0], head[1], 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
