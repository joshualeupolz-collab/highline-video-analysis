/**
 * Node helper: decodes a video with the system ffmpeg into downscaled gray frames.
 * Only for local experiments and evaluation; the browser uses src/analysis/videoFrames.ts.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { GrayFrame } from "../src/analysis/types";

export function probeSize(file: string): { width: number; height: number } {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height:stream_side_data=rotation",
    "-of", "json", file,
  ]).toString();
  const s = JSON.parse(out).streams[0];
  const rot = Math.abs(s.side_data_list?.[0]?.rotation ?? 0);
  return rot === 90 ? { width: s.height, height: s.width } : { width: s.width, height: s.height };
}

export async function* grayFrames(file: string, fps: number, width: number): AsyncGenerator<GrayFrame> {
  const size = probeSize(file);
  let height = Math.round((size.height * width) / size.width);
  height += height % 2;
  const ff = spawn("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `fps=${fps},scale=${width}:${height}:flags=area,format=gray`,
    "-f", "rawvideo", "-",
  ]);
  const frameBytes = width * height;
  let buf = Buffer.alloc(0);
  let index = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const data = new Float32Array(frameBytes);
      for (let i = 0; i < frameBytes; i++) data[i] = buf[i];
      buf = buf.subarray(frameBytes);
      yield { data, width, height, time: index / fps };
      index++;
    }
  }
}
