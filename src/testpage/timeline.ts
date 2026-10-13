import type { PoseSignals } from "../analysis/pose/types";
import type { AnalysisResult, Signals } from "../analysis/types";

export interface TimelineView {
  start: number;
  end: number;
}

export interface TimelineData {
  auto: AnalysisResult | null;
  signals: Signals | null;
  manual: number[];
  manualCuts: number[];
  playhead: number;
}

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

/** Draws signals and markers for the time range `view` into `canvas`. */
export function drawTimeline(canvas: HTMLCanvasElement, view: TimelineView, data: TimelineData) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const span = Math.max(1e-6, view.end - view.start);
  const x = (t: number) => ((t - view.start) / span) * cssW;
  const top = 14;
  const bottom = cssH - 16;

  // Time grid
  ctx.fillStyle = css("--muted");
  ctx.strokeStyle = css("--border");
  ctx.font = "10px system-ui, sans-serif";
  ctx.lineWidth = 1;
  const step = span > 40 ? 5 : span > 12 ? 2 : span > 4 ? 1 : 0.5;
  for (let t = Math.ceil(view.start / step) * step; t <= view.end; t += step) {
    ctx.beginPath();
    ctx.moveTo(x(t) + 0.5, top);
    ctx.lineTo(x(t) + 0.5, bottom);
    ctx.stroke();
    ctx.fillText(`${Number(t.toFixed(1))}`, x(t) + 2, cssH - 4);
  }

  // Signals
  const s = data.signals;
  if (s) {
    const plot = (values: number[], color: string, width: number) => {
      const i0 = Math.max(0, Math.floor((view.start - s.t0) * s.rate));
      const i1 = Math.min(values.length - 1, Math.ceil((view.end - s.t0) * s.rate));
      if (i1 <= i0) return;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of values) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const range = hi - lo || 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const px = x(s.t0 + i / s.rate);
        // Height: larger value = lower athlete, drawn lower
        const py = top + ((values[i] - lo) / range) * (bottom - top);
        if (i === i0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    };
    plot(s.motion.map((v) => -v), css("--motion"), 1);
    plot(s.height, css("--height"), 1.5);
  }

  // Cuts
  ctx.strokeStyle = css("--cut");
  ctx.lineWidth = 2;
  for (const t of data.manualCuts) line(ctx, x(t), top, bottom);
  ctx.setLineDash([4, 3]);
  for (const t of data.auto?.signals.cuts ?? []) line(ctx, x(t), top, bottom);
  ctx.setLineDash([]);

  // Manual BDCs
  ctx.strokeStyle = css("--good");
  ctx.fillStyle = css("--good");
  ctx.lineWidth = 2.5;
  for (const t of data.manual) {
    line(ctx, x(t), top, bottom);
    ctx.fillRect(x(t) - 4, bottom - 8, 8, 8);
  }

  // Automatic BDCs
  ctx.fillStyle = css("--auto");
  for (const c of data.auto?.cutPoints ?? []) {
    ctx.globalAlpha = 0.35 + 0.65 * c.confidence;
    const px = x(c.time);
    ctx.beginPath();
    ctx.moveTo(px - 6, 1);
    ctx.lineTo(px + 6, 1);
    ctx.lineTo(px, top);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = css("--auto");
    ctx.lineWidth = 1;
    line(ctx, px, top, bottom);
  }
  ctx.globalAlpha = 1;

  // Playhead
  ctx.strokeStyle = css("--fg");
  ctx.lineWidth = 1.5;
  line(ctx, x(data.playhead), 0, cssH);
}

function line(ctx: CanvasRenderingContext2D, px: number, y0: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(px, y0);
  ctx.lineTo(px, y1);
  ctx.stroke();
}

/** Knee angle, body tilt and feet height over time, with the BDC marks. */
export function drawPoseChart(
  canvas: HTMLCanvasElement,
  view: TimelineView,
  pose: PoseSignals,
  marks: { manual: number[]; auto: number[]; playhead: number },
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || canvas.height;
  if (canvas.width !== Math.round(cssW * dpr)) {
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const span = Math.max(1e-6, view.end - view.start);
  const x = (t: number) => ((t - view.start) / span) * cssW;
  const top = 6;
  const bottom = cssH - 6;
  const plot = (values: number[], toUnit: (v: number) => number, color: string) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let pen = false;
    const i0 = Math.max(0, Math.floor(view.start * pose.rate));
    const i1 = Math.min(values.length - 1, Math.ceil(view.end * pose.rate));
    for (let i = i0; i <= i1; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) {
        pen = false;
        continue;
      }
      const u = Math.max(0, Math.min(1, toUnit(v)));
      const px = x(pose.t0 + i / pose.rate);
      const py = bottom - u * (bottom - top);
      if (pen) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      pen = true;
    }
    ctx.stroke();
  };
  const finite = pose.feet.filter(Number.isFinite);
  const lo = Math.min(...finite, 0);
  const hi = Math.max(...finite, 0);
  plot(pose.feet, (v) => 1 - (v - lo) / (hi - lo || 1), css("--feet"));
  plot(pose.tilt, (v) => v / 180, css("--tilt"));
  plot(pose.legs, (v) => (v - 50) / 50, css("--knee"));

  ctx.lineWidth = 2;
  ctx.strokeStyle = css("--good");
  for (const t of marks.manual) line(ctx, x(t), top, bottom);
  ctx.lineWidth = 1;
  ctx.strokeStyle = css("--auto");
  for (const t of marks.auto) line(ctx, x(t), top, bottom);
  ctx.strokeStyle = css("--fg");
  ctx.lineWidth = 1.5;
  line(ctx, x(marks.playhead), 0, cssH);
}
