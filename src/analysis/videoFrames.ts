/**
 * Browser frame source: plays a video muted and fast, grabbing downscaled gray frames with
 * requestVideoFrameCallback. Falls back to seeking frame by frame where that API is missing.
 */
import type { GrayFrame } from "./types";

export interface FrameSourceOptions {
  /** Width of the gray frames in pixels. */
  width: number;
  /** Target sampling rate in video seconds (frames closer together are skipped). */
  fps: number;
  /** Playback speed while sampling. Higher is faster but drops more frames. */
  playbackRate: number;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export const defaultFrameSourceOptions: FrameSourceOptions = {
  width: 160,
  fps: 15,
  // 2×: every sample is the frame its timestamp says (checked with a frame-numbered test video);
  // at 4× about 15 % of the samples were two frames newer, at 8× more.
  playbackRate: 2,
};

type VideoWithRvfc = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: { mediaTime: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function once(target: EventTarget, event: string): Promise<void> {
  return new Promise((resolve) => target.addEventListener(event, () => resolve(), { once: true }));
}

/** Loads a video file into a detached, muted video element. */
export async function loadVideo(src: Blob | string): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = typeof src === "string" ? src : URL.createObjectURL(src);
  if (video.readyState < 1) {
    await Promise.race([
      once(video, "loadedmetadata"),
      once(video, "error").then(() => {
        throw new Error("Could not load video");
      }),
    ]);
  }
  return video;
}

function makeGrabber(video: HTMLVideoElement, width: number) {
  const height = Math.max(2, Math.round((video.videoHeight * width) / video.videoWidth / 2) * 2);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  return (time: number): GrayFrame => {
    ctx.drawImage(video, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Float32Array(width * height);
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      data[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    }
    return { data, width, height, time };
  };
}

/**
 * Calls `onFrame` for sampled frames of the whole video, in time order.
 * Resolves with the video duration.
 */
export async function sampleFrames(
  video: HTMLVideoElement,
  onFrame: (frame: GrayFrame) => void,
  options: Partial<FrameSourceOptions> = {},
): Promise<number> {
  const o = { ...defaultFrameSourceOptions, ...options };
  const grab = makeGrabber(video, o.width);
  return playFrames(video, (t) => onFrame(grab(t)), o);
}

export interface PlayOptions {
  /** Target sampling rate in video seconds. */
  fps: number;
  /** Fixed playback speed. Ignored when `adaptive` is set. */
  playbackRate?: number;
  /** Seconds until the next wanted sample, asked after every sample (default 1 / fps). */
  nextStep?: () => number;
  /**
   * Pause the video while `onFrame` works, so slow work (a phone's first GPU inference can take
   * seconds) never makes the video run past wanted samples. Playback speed between samples then
   * follows the step: about every frame is presented when the step is one frame.
   */
  pauseWhileWorking?: boolean;
  /**
   * Adjust the playback speed to how long `onFrame` takes, so that slow per-frame work (pose
   * detection) still gets about `fps` samples per video second.
   */
  adaptive?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Plays the video from the start (muted) and calls `onFrame(time)` with the current frame on screen
 * in the video element, about `fps` times per video second. Resolves with the duration.
 */
export async function playFrames(
  video: HTMLVideoElement,
  onFrame: (time: number) => void,
  o: PlayOptions,
): Promise<number> {
  const v = video as VideoWithRvfc;
  const duration = video.duration;
  let step = 1 / o.fps;

  if (!v.requestVideoFrameCallback) {
    for (let t = 0; t < duration; t += step) {
      if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      video.currentTime = t;
      await once(video, "seeked");
      onFrame(t);
      o.onProgress?.(t / duration);
      step = o.nextStep?.() ?? step;
    }
    return duration;
  }

  video.pause();
  if (video.currentTime !== 0) {
    video.currentTime = 0;
    await once(video, "seeked");
  }
  let rate = o.adaptive ? 1 : (o.playbackRate ?? 1);
  video.playbackRate = rate;
  return new Promise<number>((resolve, reject) => {
    let last = -Infinity;
    let handle = 0;
    let busy = 0;
    let calls = 0;
    const finish = () => {
      v.cancelVideoFrameCallback?.(handle);
      video.removeEventListener("ended", finish);
      video.pause();
      video.playbackRate = 1;
      o.onProgress?.(1);
      resolve(duration);
    };
    const onVideoFrame = (_now: number, meta: { mediaTime: number }) => {
      if (o.signal?.aborted) {
        video.removeEventListener("ended", finish);
        video.pause();
        video.playbackRate = 1;
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (meta.mediaTime - last >= step * 0.9) {
        last = meta.mediaTime;
        const time = meta.mediaTime;
        if (o.pauseWhileWorking) video.pause();
        const started = performance.now();
        onFrame(time);
        const work = (performance.now() - started) / 1000;
        o.onProgress?.(time / duration);
        step = o.nextStep?.() ?? step;
        if (o.pauseWhileWorking) {
          // Never faster than 1×: above that the browser skips frames and the frame on screen can be
          // newer than the one this callback reports (checked with a frame-numbered test video)
          const want = Math.max(0.5, Math.min(1, step * 30));
          if (Math.abs(want - video.playbackRate) > 0.05) video.playbackRate = want;
          if (video.currentTime < duration) video.play().catch(() => undefined);
        } else if (o.adaptive) {
          // Video may advance by `step` while one sample's work takes `work`: keep ~30 % headroom
          busy = busy ? busy * 0.8 + work * 0.2 : work;
          calls++;
          const next = Math.max(0.25, Math.min(4, (0.7 * step) / Math.max(busy, 1e-3)));
          if (calls >= 3 && Math.abs(next - rate) / rate > 0.15) {
            rate = next;
            video.playbackRate = rate;
          }
        }
      }
      handle = v.requestVideoFrameCallback!(onVideoFrame);
    };
    handle = v.requestVideoFrameCallback!(onVideoFrame);
    video.addEventListener("ended", finish);
    video.play().catch(reject);
  });
}
