import { analyze } from "../analysis/analyze";
import { evaluateCutPoints } from "../analysis/evaluate";
import { legExtension, legReference, poseFeatures } from "../analysis/pose/features";
import { bounceProfiles } from "../analysis/pose/profile";
import type { AnalysisResult } from "../analysis/types";
import { drawSkeleton, poseAt } from "./skeleton";
import { drawPoseChart, drawTimeline, type TimelineView } from "./timeline";

/** Hand-marked ground truth, stored as `<video>.bdc.json`. */
interface ManualMarks {
  format: "highline-bdc/1";
  video: string;
  duration: number;
  /** Bottom dead centers in seconds. */
  bdc: number[];
  /** Hard cuts (changes of shot) in seconds. */
  cuts: number[];
  /** Trick names per bounce: the bounce from BDC `start` to the next BDC `end`. */
  tricks: Trick[];
  savedAt?: string;
}

interface Trick {
  start: number;
  end: number;
  name: string;
}

interface Entry {
  file: File;
  url: string;
  marks: ManualMarks;
  auto: AnalysisResult | null;
}

const FRAME = 1 / 30;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const list = $<HTMLSelectElement>("videoList");
const overview = $<HTMLCanvasElement>("overview");
const detail = $<HTMLCanvasElement>("detail");
const statusEl = $("status");
const overlay = $<HTMLCanvasElement>("overlay");
const poseChart = $<HTMLCanvasElement>("poseChart");
const trickInput = $<HTMLInputElement>("trick");
const blind = $<HTMLInputElement>("blind");

const entries: Entry[] = [];
const pendingJson = new Map<string, ManualMarks>();
let current: Entry | null = null;
let analyzing: AbortController | null = null;

// ---------- storage ----------

const storageKey = (f: File) => `bdc:${f.name}:${f.size}`;

function persist(e: Entry) {
  try {
    localStorage.setItem(storageKey(e.file), JSON.stringify(e.marks));
  } catch {
    /* storage unavailable: marks live until the page is closed */
  }
}

function restore(f: File): ManualMarks | null {
  try {
    const raw = localStorage.getItem(storageKey(f));
    return raw ? (JSON.parse(raw) as ManualMarks) : null;
  } catch {
    return null;
  }
}

try {
  blind.checked = localStorage.getItem("bdc:blind") === "1";
} catch {
  /* ignore */
}

// ---------- loading files ----------

function baseName(name: string) {
  return name.replace(/\.(bdc|auto)\.json$/i, "").replace(/\.[^.]+$/, "");
}

function normaliseMarks(raw: Partial<ManualMarks>, video: string): ManualMarks {
  const nums = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is number => typeof x === "number") : []);
  return {
    format: "highline-bdc/1",
    video: raw.video ?? video,
    duration: raw.duration ?? 0,
    bdc: nums(raw.bdc).sort((a, b) => a - b),
    cuts: nums(raw.cuts).sort((a, b) => a - b),
    tricks: Array.isArray(raw.tricks)
      ? raw.tricks.filter((t) => t && typeof t.start === "number" && typeof t.name === "string")
      : [],
  };
}

async function openFiles(files: FileList | File[]) {
  const arr = Array.from(files);
  for (const f of arr.filter((f) => /\.json$/i.test(f.name))) {
    try {
      const data = JSON.parse(await f.text());
      if (Array.isArray(data.cutPoints)) {
        // An .auto.json analysis file
        const target = entries.find((e) => baseName(e.file.name) === baseName(f.name));
        if (target) target.auto = data as AnalysisResult;
        continue;
      }
      const marks = normaliseMarks(data, f.name);
      const target = entries.find((e) => baseName(e.file.name) === baseName(marks.video || f.name));
      if (target) applyMarks(target, marks);
      else pendingJson.set(baseName(marks.video || f.name), marks);
    } catch (err) {
      alert(`Could not read ${f.name}: ${err}`);
    }
  }
  let firstNew: Entry | null = null;
  for (const f of arr.filter((f) => f.type.startsWith("video/") || /\.(mp4|webm|mov|m4v)$/i.test(f.name))) {
    if (entries.some((e) => e.file.name === f.name && e.file.size === f.size)) continue;
    const e: Entry = {
      file: f,
      url: URL.createObjectURL(f),
      marks: normaliseMarks(restore(f) ?? {}, f.name),
      auto: null,
    };
    const pending = pendingJson.get(baseName(f.name));
    if (pending) {
      applyMarks(e, pending);
      pendingJson.delete(baseName(f.name));
    }
    entries.push(e);
    firstNew ??= e;
  }
  renderList();
  if (firstNew) select(firstNew);
  else if (current) refresh();
}

function applyMarks(e: Entry, marks: ManualMarks) {
  const has = e.marks.bdc.length + e.marks.cuts.length > 0;
  if (has && !confirm(`Replace your current marks for ${e.file.name} with the ones from the JSON file?`)) return;
  e.marks = { ...marks, video: e.file.name };
  persist(e);
}

function renderList() {
  list.innerHTML = "";
  for (const [i, e] of entries.entries()) {
    const o = document.createElement("option");
    o.value = String(i);
    o.textContent = `${e.file.name}  (${e.marks.bdc.length} marks${e.auto ? ", analysed" : ""})`;
    list.append(o);
  }
  if (current) list.value = String(entries.indexOf(current));
  $("empty").hidden = entries.length > 0;
  $("main").hidden = entries.length === 0;
}

function select(e: Entry) {
  analyzing?.abort();
  $("textBox").hidden = true;
  current = e;
  video.src = e.url;
  video.playbackRate = Number(($("rate") as HTMLSelectElement).value);
  renderList();
  refresh();
}

// ---------- marks ----------

function time() {
  return video.currentTime;
}

function addMark(kind: "bdc" | "cuts", t = time()) {
  if (!current) return;
  const arr = current.marks[kind];
  if (arr.some((x) => Math.abs(x - t) < 0.05)) return;
  arr.push(Number(t.toFixed(3)));
  arr.sort((a, b) => a - b);
  changed();
}

function deleteNearest() {
  if (!current) return;
  const t = time();
  let best: { kind: "bdc" | "cuts"; i: number; d: number } | null = null;
  for (const kind of ["bdc", "cuts"] as const) {
    current.marks[kind].forEach((x, i) => {
      const d = Math.abs(x - t);
      if (d < 1 && (!best || d < best.d)) best = { kind, i, d };
    });
  }
  if (best) {
    const b = best as { kind: "bdc" | "cuts"; i: number };
    current.marks[b.kind].splice(b.i, 1);
    changed();
  }
}

function jump(dir: 1 | -1) {
  if (!current) return;
  const t = time();
  const all = [...current.marks.bdc, ...(showAuto() ? (current.auto?.cutPoints.map((c) => c.time) ?? []) : [])].sort(
    (a, b) => a - b,
  );
  const target = dir > 0 ? all.find((x) => x > t + 0.02) : [...all].reverse().find((x) => x < t - 0.02);
  if (target !== undefined) seek(target);
}

function changed() {
  if (!current) return;
  current.marks.duration = video.duration || current.marks.duration;
  persist(current);
  renderList();
  refresh();
}

function seek(t: number) {
  video.pause();
  video.currentTime = Math.max(0, Math.min(video.duration || 0, t));
  refresh();
}

const showAuto = () => !blind.checked;

// ---------- drawing ----------

function views(): [TimelineView, TimelineView] {
  const sig = current?.auto?.signals;
  const d = video.duration || (sig ? sig.height.length / sig.rate : 1);
  const t = time();
  const span = Math.min(8, d);
  const start = Math.max(0, Math.min(d - span, t - span / 2));
  return [
    { start: 0, end: d },
    { start, end: start + span },
  ];
}

function refresh() {
  if (!current) return;
  $("time").textContent = `${time().toFixed(2)} s`;
  const scrub = $("scrub") as HTMLInputElement;
  if (video.duration) scrub.max = String(video.duration);
  if (document.activeElement !== scrub) scrub.value = String(time());
  $("playBtn").textContent = video.paused ? "▶" : "❚❚";
  const [a, b] = views();
  const data = {
    auto: showAuto() ? current.auto : null,
    signals: current.auto?.signals ?? null,
    manual: current.marks.bdc,
    manualCuts: current.marks.cuts,
    playhead: time(),
  };
  drawTimeline(overview, a, data);
  drawTimeline(detail, b, data);
  renderPose(a);
  renderTrick();
  renderStats();
}

let legRefCache: { track: unknown; ref: number } | null = null;

function renderPose(view: TimelineView) {
  const pose = current?.auto?.pose;
  poseChart.hidden = !pose;
  $("poseLegend").hidden = !pose;
  const frame = pose ? poseAt(pose.track, time()) : null;
  drawSkeleton(overlay, video, frame, {
    skeleton: ($("skeleton") as HTMLInputElement).checked,
    line: ($("showLine") as HTMLInputElement).checked,
  });
  const info = $("poseInfo");
  if (!pose) {
    info.textContent = "";
    return;
  }
  drawPoseChart(poseChart, view, pose.signals, {
    manual: current!.marks.bdc,
    auto: showAuto() ? current!.auto!.cutPoints.map((c) => c.time) : [],
    playhead: time(),
  });
  if (!frame) {
    info.textContent = "no pose here";
    return;
  }
  const f = poseFeatures(frame);
  legRefCache ??= { track: pose.track, ref: legReference(pose.track.frames.map(poseFeatures)) };
  if (legRefCache.track !== pose.track) legRefCache = { track: pose.track, ref: legReference(pose.track.frames.map(poseFeatures)) };
  const legs = legExtension(f, legRefCache.ref);
  const deg = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}°` : "–");
  info.textContent =
    `hip–feet ${Number.isFinite(legs) ? Math.round(legs) + " %" : "–"} · knee L ${deg(f.kneeLeft)} R ${deg(f.kneeRight)}` +
    ` · hip ${deg(f.hip)} · tilt ${deg(f.tilt)} · pose at ${frame.time.toFixed(2)} s`;
}

/** The bounce around time t: from the last BDC at or before t to the next one. */
function bounceAt(t: number): { start: number; end: number } | null {
  const marks = current?.marks.bdc.length ? current.marks.bdc : (current?.auto?.cutPoints.map((c) => c.time) ?? []);
  const start = [...marks].reverse().find((x) => x <= t + 0.01);
  const end = marks.find((x) => x > t + 0.01);
  if (start === undefined || end === undefined) return null;
  return { start, end };
}

function renderTrick() {
  if (!current) return;
  const b = bounceAt(time());
  trickInput.disabled = !b;
  $("trickRange").textContent = b ? `${b.start.toFixed(2)}–${b.end.toFixed(2)} s` : "mark BDCs first";
  const t = b ? current.marks.tricks.find((x) => Math.abs(x.start - b.start) < 0.15) : undefined;
  if (document.activeElement !== trickInput) trickInput.value = t?.name ?? "";
  const names = new Set(entries.flatMap((e) => e.marks.tricks.map((x) => x.name)));
  const dl = $("trickNames");
  if (dl.childElementCount !== names.size) {
    dl.innerHTML = "";
    for (const n of names) {
      const o = document.createElement("option");
      o.value = n;
      dl.append(o);
    }
  }
}

function setTrick(name: string) {
  if (!current) return;
  const b = bounceAt(time());
  if (!b) return;
  current.marks.tricks = current.marks.tricks.filter((x) => Math.abs(x.start - b.start) >= 0.15);
  if (name.trim()) current.marks.tricks.push({ start: b.start, end: b.end, name: name.trim() });
  current.marks.tricks.sort((x, y) => x.start - y.start);
  changed();
}

function renderStats() {
  const el = $("stats");
  if (!current) return;
  const auto = current.auto;
  const parts: string[] = [];
  if (auto) {
    parts.push(
      `<p>Automatic: <b>${auto.cutPoints.length}</b> BDCs, bounce period <b>${
        Number.isFinite(auto.period) ? auto.period.toFixed(2) + " s" : "–"
      }</b>, ${auto.signals.cuts.length} video cut(s) detected.</p>`,
    );
  }
  parts.push(`<p>Your marks: <b>${current.marks.bdc.length}</b> BDCs, ${current.marks.cuts.length} cut(s).</p>`);
  if (auto && current.marks.bdc.length && showAuto()) {
    const ev = evaluateCutPoints(
      current.marks.bdc,
      auto.cutPoints.map((c) => c.time),
      0.3,
    );
    const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)} %` : "–");
    parts.push(`<table>
      <tr><th>Found (within ±0.3 s)</th><td class="${ev.recall >= 0.9 ? "ok" : "bad"}">${ev.matches.length} / ${
        current.marks.bdc.length
      } = ${pct(ev.recall)}</td></tr>
      <tr><th>Correct suggestions</th><td>${ev.matches.length} / ${auto.cutPoints.length} = ${pct(ev.precision)}</td></tr>
      <tr><th>Mean error</th><td>${Number.isFinite(ev.meanAbsError) ? ev.meanAbsError.toFixed(2) + " s" : "–"}</td></tr>
      <tr><th>Missed</th><td class="mono">${ev.missed.map((x) => x.toFixed(2)).join(", ") || "–"}</td></tr>
      <tr><th>Extra</th><td class="mono">${ev.extra.map((x) => x.toFixed(2)).join(", ") || "–"}</td></tr>
    </table>`);
  }
  const pose = auto?.pose;
  if (pose) {
    const marks = current.marks.bdc.length >= 2 ? current.marks.bdc : auto.cutPoints.map((c) => c.time);
    const rows = bounceProfiles(pose.track, marks);
    const deg = (v: number) => (Number.isFinite(v) ? `${Math.round(v)}°` : "–");
    const pct = (v: number) => (Number.isFinite(v) ? `${Math.round(v)} %` : "–");
    const name = (start: number) => current!.marks.tricks.find((t) => Math.abs(t.start - start) < 0.15)?.name ?? "";
    parts.push(`<h3>Body per bounce</h3>
      <p class="hint">Between ${current.marks.bdc.length >= 2 ? "your" : "the automatic"} BDC marks. Hip–feet: distance
        hip to feet in % of the distance with straight legs (100 % = straight, smaller = knees bent). Rotation: 360° =
        one full turn of the upper body in the picture. Pose found: share of this bounce's pose samples with a body.
        Click a row to jump there.</p>
      <div class="scroll"><table class="bounces">
      <tr><th>from</th><th>trick</th><th>hip–feet at BDC</th><th>smallest hip–feet</th><th>min hip angle</th>
        <th>max tilt</th><th>rotation</th><th>upside down</th><th>arms up</th><th>pose found</th></tr>
      ${rows
        .map(
          (r) => `<tr data-seek="${r.start}"><td class="mono">${r.start.toFixed(2)} s</td><td>${escapeHtml(name(r.start))}</td>
        <td>${pct(r.legsAtStart)}</td><td>${pct(r.legsMin)}${Number.isFinite(r.legsMinAt) ? ` <span class="hint">at +${r.legsMinAt.toFixed(1)} s</span>` : ""}</td>
        <td>${deg(r.hipMin)}</td><td>${deg(r.tiltMax)}</td>
        <td>${deg(r.rotation)}</td><td>${r.invertedTime.toFixed(1)} s</td>
        <td>${Number.isFinite(r.armsUp) ? Math.round(r.armsUp * 100) + " %" : "–"}</td>
        <td>${Math.round(r.coverage * 100)} %</td></tr>`,
        )
        .join("")}
      </table></div>`);
  }
  el.innerHTML = parts.join("");
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------- timeline interaction ----------

function attachTimeline(canvas: HTMLCanvasElement, which: 0 | 1) {
  let dragIndex = -1;
  const toTime = (ev: PointerEvent) => {
    const v = views()[which];
    const r = canvas.getBoundingClientRect();
    return v.start + ((ev.clientX - r.left) / r.width) * (v.end - v.start);
  };
  canvas.addEventListener("pointerdown", (ev) => {
    if (!current) return;
    canvas.setPointerCapture(ev.pointerId);
    const v = views()[which];
    const r = canvas.getBoundingClientRect();
    const t = toTime(ev);
    const tol = (12 / r.width) * (v.end - v.start);
    let best = -1;
    current.marks.bdc.forEach((x, i) => {
      if (Math.abs(x - t) <= tol && (best < 0 || Math.abs(x - t) < Math.abs(current!.marks.bdc[best] - t))) best = i;
    });
    dragIndex = best;
    if (dragIndex < 0) seek(t);
  });
  canvas.addEventListener("pointermove", (ev) => {
    if (!current || !canvas.hasPointerCapture(ev.pointerId)) return;
    const t = Math.max(0, Math.min(video.duration || Infinity, toTime(ev)));
    if (dragIndex >= 0) {
      current.marks.bdc[dragIndex] = Number(t.toFixed(3));
      video.currentTime = t;
      refresh();
    } else seek(t);
  });
  const end = (ev: PointerEvent) => {
    if (!current || !canvas.hasPointerCapture(ev.pointerId)) return;
    canvas.releasePointerCapture(ev.pointerId);
    if (dragIndex >= 0) {
      current.marks.bdc.sort((a, b) => a - b);
      dragIndex = -1;
      changed();
    }
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

// ---------- analysis ----------

async function runAnalysis() {
  if (!current) return;
  if (analyzing) {
    analyzing.abort();
    return;
  }
  const entry = current;
  const ctl = new AbortController();
  analyzing = ctl;
  const btn = document.querySelector<HTMLButtonElement>('[data-act="analyze"]')!;
  btn.textContent = "Stop analysis";
  const started = performance.now();
  try {
    const usePose = ($("usePose") as HTMLInputElement).checked;
    entry.auto = await analyze(entry.file, {
      frames: { playbackRate: Number(($("analysisRate") as HTMLSelectElement).value) },
      pose: usePose
        ? {
            model: ($("poseModel") as HTMLSelectElement).value as "lite" | "full",
            fps: Number(($("poseFps") as HTMLSelectElement).value),
            // ?cpu forces the CPU delegate (headless test browsers have no real GPU)
            delegate: new URLSearchParams(location.search).has("cpu") ? "CPU" : "GPU",
          }
        : false,
      signal: ctl.signal,
      onProgress: (phase, f) =>
        (statusEl.textContent = `${phase === "motion" ? "motion" : "body pose"}… ${Math.round(f * 100)} %`),
    });
    const pose = entry.auto.pose;
    statusEl.textContent =
      `done in ${((performance.now() - started) / 1000).toFixed(1)} s` +
      (pose
        ? ` · pose found in ${pose.track.frames.length} of ${pose.track.sampled} pose samples ` +
          `(${Math.round((100 * pose.track.frames.length) / Math.max(1, pose.track.sampled))} %)`
        : "");
  } catch (err) {
    statusEl.textContent = (err as Error).name === "AbortError" ? "stopped" : `error: ${err}`;
  } finally {
    analyzing = null;
    btn.textContent = "Run automatic analysis";
    renderList();
    if (current === entry) refresh();
  }
}

// ---------- full screen ----------

/** Full screen for the whole stage (video + skeleton + buttons); CSS fallback where the API is missing (iPhone). */
function toggleFullscreen() {
  const stage = $("stage") as HTMLElement & { webkitRequestFullscreen?: () => void };
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  if (document.fullscreenElement || doc.webkitFullscreenElement) {
    (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()) as unknown;
    return;
  }
  if (stage.classList.contains("pseudo-fs")) {
    stage.classList.remove("pseudo-fs");
    refresh();
    return;
  }
  const request = stage.requestFullscreen?.bind(stage) ?? stage.webkitRequestFullscreen?.bind(stage);
  if (request) {
    Promise.resolve(request()).catch(() => stage.classList.add("pseudo-fs"));
  } else stage.classList.add("pseudo-fs");
  refresh();
}
document.addEventListener("fullscreenchange", () => setTimeout(refresh, 50));

// ---------- saving ----------

/** Minimal shape of the claude.ai artifact runtime, present only when the page is hosted there. */
type ArtifactRuntime = {
  use(name: "downloads"): Promise<{ save(r: { filename: string; data: string }): Promise<unknown> } | null>;
};

async function download(name: string, data: unknown) {
  const text = JSON.stringify(data, null, 1);
  const runtime = (window as unknown as { claude?: ArtifactRuntime }).claude;
  const saver = runtime ? await runtime.use("downloads").catch(() => null) : null;
  if (saver) {
    // Hosted as a claude.ai artifact: plain download links are blocked there.
    try {
      await saver.save({ filename: name, data: text });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "declined") alert(`Could not save ${name} (${code ?? err}).`);
    }
    return;
  }
  const blob = new Blob([text], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- wiring ----------

const actions: Record<string, () => void> = {
  "back-big": () => seek(time() - 0.5),
  back: () => seek(time() - FRAME),
  play: () => (video.paused ? video.play() : video.pause()),
  fwd: () => seek(time() + FRAME),
  "fwd-big": () => seek(time() + 0.5),
  mark: () => addMark("bdc"),
  cut: () => addMark("cuts"),
  delete: deleteNearest,
  prev: () => jump(-1),
  next: () => jump(1),
  analyze: runAnalysis,
  fullscreen: toggleFullscreen,
  save: () => {
    if (!current) return;
    const m = { ...current.marks, duration: video.duration, savedAt: new Date().toISOString() };
    void download(`${baseName(current.file.name)}.bdc.json`, m);
  },
  "save-auto": () => {
    if (!current?.auto) return alert("Run the analysis first.");
    void download(`${baseName(current.file.name)}.auto.json`, current.auto);
  },
  adopt: () => {
    if (!current?.auto) return alert("Run the analysis first.");
    if (current.marks.bdc.length && !confirm("Replace your BDC marks with the automatic ones?")) return;
    current.marks.bdc = current.auto.cutPoints.map((c) => Number(c.time.toFixed(3)));
    changed();
  },
  text: () => {
    if (!current) return;
    const m = { ...current.marks, duration: video.duration, savedAt: new Date().toISOString() };
    $("textName").textContent = `videos/${baseName(current.file.name)}.bdc.json`;
    ($("marksText") as HTMLTextAreaElement).value = JSON.stringify(m);
    $("copyStatus").textContent = "";
    $("textBox").hidden = false;
  },
  copy: () => {
    const area = $("marksText") as HTMLTextAreaElement;
    area.select();
    const done = () => ($("copyStatus").textContent = "copied");
    const manual = () => ($("copyStatus").textContent = "select the text and copy it by hand");
    if (navigator.clipboard) navigator.clipboard.writeText(area.value).then(done, () => (document.execCommand("copy") ? done() : manual()));
    else if (document.execCommand("copy")) done();
    else manual();
  },
  clear: () => {
    if (!current || !confirm("Delete all your marks for this video?")) return;
    current.marks.bdc = [];
    current.marks.cuts = [];
    current.marks.tricks = [];
    changed();
  },
};

document.addEventListener("click", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>("[data-seek]");
  if (row) seek(Number(row.dataset.seek) + 0.05);
  const act = (ev.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
  if (act) actions[act]?.();
});

document.addEventListener("keydown", (ev) => {
  const tag = (ev.target as HTMLElement).tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const map: Record<string, string> = {
    " ": "play",
    ArrowLeft: ev.shiftKey ? "back-big" : "back",
    ArrowRight: ev.shiftKey ? "fwd-big" : "fwd",
    m: "mark",
    M: "mark",
    c: "cut",
    C: "cut",
    Delete: "delete",
    Backspace: "delete",
    n: "next",
    N: "next",
    p: "prev",
    P: "prev",
    f: "fullscreen",
    F: "fullscreen",
    Escape: "exit-fullscreen",
  };
  const act = map[ev.key];
  if (act === "exit-fullscreen") {
    if ($("stage").classList.contains("pseudo-fs")) toggleFullscreen();
    return;
  }
  if (act) {
    ev.preventDefault();
    actions[act]();
  }
});

$<HTMLInputElement>("files").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.files) void openFiles(input.files);
  input.value = "";
});
document.addEventListener("dragover", (ev) => ev.preventDefault());
document.addEventListener("drop", (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer?.files.length) void openFiles(ev.dataTransfer.files);
});
list.addEventListener("change", () => select(entries[Number(list.value)]));
$<HTMLSelectElement>("rate").addEventListener("change", (ev) => {
  video.playbackRate = Number((ev.target as HTMLSelectElement).value);
});
blind.addEventListener("change", () => {
  try {
    localStorage.setItem("bdc:blind", blind.checked ? "1" : "0");
  } catch {
    /* ignore */
  }
  refresh();
});
video.addEventListener("loadedmetadata", refresh);
video.addEventListener("seeked", refresh);
video.addEventListener("ratechange", () => {
  // The analysis never touches the visible player, but keep the selector in sync anyway.
  ($("rate") as HTMLSelectElement).value = String(video.playbackRate);
});
trickInput.addEventListener("change", () => setTrick(trickInput.value));
($("scrub") as HTMLInputElement).addEventListener("input", (ev) => seek(Number((ev.target as HTMLInputElement).value)));
video.addEventListener("play", refresh);
video.addEventListener("pause", refresh);
($("skeleton") as HTMLInputElement).addEventListener("change", refresh);
($("showLine") as HTMLInputElement).addEventListener("change", refresh);
attachTimeline(overview, 0);
attachTimeline(detail, 1);
new ResizeObserver(refresh).observe(overview);
new ResizeObserver(refresh).observe(video);

// Hook for automated tests (scripts/browser-eval.mjs).
(window as unknown as { bdcBench: unknown }).bdcBench = { analyze };

(function tick() {
  if (current && !video.paused) refresh();
  requestAnimationFrame(tick);
})();
