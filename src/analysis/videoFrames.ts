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
  playbackRate: 4,
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
  const v = video as VideoWithRvfc;
  const grab = makeGrabber(video, o.width);
  const duration = video.duration;
  const step = 1 / o.fps;

  if (!v.requestVideoFrameCallback) {
    for (let t = 0; t < duration; t += step) {
      if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      video.currentTime = t;
      await once(video, "seeked");
      onFrame(grab(t));
      o.onProgress?.(t / duration);
    }
    return duration;
  }

  video.pause();
  if (video.currentTime !== 0) {
    video.currentTime = 0;
    await once(video, "seeked");
  }
  video.playbackRate = o.playbackRate;
  return new Promise<number>((resolve, reject) => {
    let last = -Infinity;
    let handle = 0;
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
        video.pause();
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      if (meta.mediaTime - last >= step * 0.9) {
        last = meta.mediaTime;
        onFrame(grab(meta.mediaTime));
        o.onProgress?.(meta.mediaTime / duration);
      }
      handle = v.requestVideoFrameCallback!(onVideoFrame);
    };
    handle = v.requestVideoFrameCallback!(onVideoFrame);
    video.addEventListener("ended", finish);
    video.play().catch(reject);
  });
}
