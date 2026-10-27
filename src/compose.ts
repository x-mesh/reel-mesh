import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { FrameRecord } from "./recorder.ts";
import type { Scenario } from "./scenario.ts";
import { CLI_PATH } from "./runlog.ts";

export const GIF_FPS = 15;
export const GIF_COLORS = 200;
export const DEFAULT_BUDGET_MB = 3;
const BORDER_COLOR = "gray";
const SHEET_COLUMNS = 4;
const SHEET_THUMB_WIDTH = 400;
const FFMPEG_TAIL_LINES = 6;
const PNG_HEADER_BYTES = 24;

export class ComposeError extends Error {}

export interface Workspace {
  dir: string;
  framesPath: string;
  logPath: string;
}

export function workspaceOf(scenario: Scenario, baseDir: string = process.cwd()): Workspace {
  const dir = join(baseDir, ".reel", scenario.name);
  return { dir, framesPath: join(dir, "frames.json"), logPath: join(dir, "ffmpeg.log") };
}

export function readFrames(ws: Workspace): FrameRecord[] {
  if (!existsSync(ws.framesPath)) throw new ComposeError(`${ws.framesPath}가 없습니다. 먼저 record를 실행하세요`);
  let frames: FrameRecord[];
  try {
    frames = JSON.parse(readFileSync(ws.framesPath, "utf8")) as FrameRecord[];
  } catch (e) {
    throw new ComposeError(`${ws.framesPath}를 읽지 못했습니다 (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!Array.isArray(frames) || frames.length === 0) throw new ComposeError(`${ws.framesPath}에 프레임이 없습니다`);
  return frames;
}

async function runFfmpeg(args: string[], logPath: string): Promise<void> {
  const full = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-y", ...args];
  const command = `ffmpeg ${full.join(" ")}`;
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `$ ${command}\n`);
  const stderr = await new Promise<{ text: string; code: number | null; spawnError: string | null }>((done) => {
    const child = spawn("ffmpeg", full, { stdio: ["ignore", "ignore", "pipe"] });
    let text = "";
    child.stderr.on("data", (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.once("error", (e) => done({ text, code: null, spawnError: e.message }));
    child.once("close", (code) => done({ text, code, spawnError: null }));
  });
  appendFileSync(logPath, stderr.text);
  if (stderr.code === 0) return;
  const tail = stderr.text.trim().split("\n").slice(-FFMPEG_TAIL_LINES).join("\n");
  const why = stderr.spawnError ?? `exit ${stderr.code}`;
  throw new ComposeError(`ffmpeg 실패 (${why})\n${tail}\n명령: ${command}`);
}

export interface PngSize {
  width: number;
  height: number;
}

function pngSize(path: string): PngSize {
  let header: Buffer;
  try {
    header = readFileSync(path).subarray(0, PNG_HEADER_BYTES);
  } catch (e) {
    throw new ComposeError(`프레임 파일을 읽지 못했습니다: ${path} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (header.length < PNG_HEADER_BYTES || header.toString("latin1", 1, 4) !== "PNG") throw new ComposeError(`PNG가 아닌 프레임 파일입니다: ${path}`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

function screenIds(scenario: Scenario, frames: FrameRecord[]): string[] {
  const recorded = Object.keys(frames[0]!.screens);
  const ids = scenario.screens.map((s) => s.id).filter((id) => recorded.includes(id));
  if (ids.length === 0) throw new ComposeError("frames.json의 화면 ID가 시나리오 화면과 하나도 맞지 않습니다");
  return ids;
}

function framePath(ws: Workspace, frame: FrameRecord, id: string): string {
  const rel = frame.screens[id];
  if (rel === undefined) throw new ComposeError(`프레임 ${frame.index}에 화면 '${id}'가 없습니다`);
  return resolve(dirname(ws.framesPath), rel);
}

// Screens of different height (horizontal) or width (vertical) are padded with the border color
// to the largest one, aligned top/left. Content is never stretched.
function stackFilter(sizes: PngSize[], layout: Scenario["layout"], out: string): { filter: string; size: PngSize } {
  const horizontal = layout.direction === "horizontal";
  const cross = Math.max(...sizes.map((s) => (horizontal ? s.height : s.width)));
  const parts = sizes.map((s, i) => {
    const gap = i === 0 ? 0 : layout.border;
    const w = horizontal ? s.width + gap : cross;
    const h = horizontal ? cross : s.height + gap;
    const x = horizontal ? gap : 0;
    const y = horizontal ? 0 : gap;
    return `[${i}:v]pad=${w}:${h}:${x}:${y}:color=${BORDER_COLOR}[s${i}]`;
  });
  const labels = sizes.map((_, i) => `[s${i}]`).join("");
  const stack = sizes.length === 1 ? `${labels}null` : `${labels}${horizontal ? "hstack" : "vstack"}=inputs=${sizes.length}`;
  const main = sizes.reduce((sum, s) => sum + (horizontal ? s.width : s.height), 0) + layout.border * (sizes.length - 1);
  return {
    filter: `${parts.join(";")};${stack}[${out}]`,
    size: { width: horizontal ? main : cross, height: horizontal ? cross : main },
  };
}

function sizesOf(ws: Workspace, ids: string[], frame: FrameRecord): PngSize[] {
  return ids.map((id) => pngSize(framePath(ws, frame, id)));
}

export async function composeStill(scenario: Scenario, ws: Workspace, frame: FrameRecord, out: string): Promise<PngSize> {
  const ids = screenIds(scenario, [frame]);
  const { filter, size } = stackFilter(sizesOf(ws, ids, frame), scenario.layout, "out");
  mkdirSync(dirname(out), { recursive: true });
  const inputs = ids.flatMap((id) => ["-i", framePath(ws, frame, id)]);
  await runFfmpeg([...inputs, "-filter_complex", filter, "-map", "[out]", "-frames:v", "1", out], ws.logPath);
  return size;
}

function startTimes(frames: FrameRecord[]): number[] {
  let t = 0;
  return frames.map((f) => {
    const start = t;
    t += f.durationMs;
    return start;
  });
}

export function sampleIndexes(frames: FrameRecord[], intervalMs: number): number[] {
  const starts = startTimes(frames);
  const total = starts[starts.length - 1]! + frames[frames.length - 1]!.durationMs;
  const picked: number[] = [];
  let cursor = 0;
  for (let t = 0; t < total; t += intervalMs) {
    while (cursor + 1 < frames.length && starts[cursor + 1]! <= t) cursor++;
    if (picked[picked.length - 1] !== cursor) picked.push(cursor);
  }
  return picked;
}

export interface ReviewResult {
  contactSheet: string;
  sheetFrames: number;
  stepImages: string[];
}

export async function runReview(scenario: Scenario, baseDir: string = process.cwd()): Promise<ReviewResult> {
  const ws = workspaceOf(scenario, baseDir);
  const frames = readFrames(ws);
  const reviewDir = join(ws.dir, "review");
  const workDir = join(ws.dir, "compose");
  mkdirSync(reviewDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const lastOfStep = new Map<number, FrameRecord>();
  for (const f of frames) lastOfStep.set(f.step, f);
  const stepImages: string[] = [];
  for (const [step, frame] of lastOfStep) {
    const out = join(reviewDir, `step-${step}.png`);
    await composeStill(scenario, ws, frame, out);
    stepImages.push(out);
  }

  const picked = sampleIndexes(frames, scenario.timing.contactSheetIntervalMs);
  for (const [i, index] of picked.entries()) await composeStill(scenario, ws, frames[index]!, join(workDir, `sheet-${String(i + 1).padStart(4, "0")}.png`));
  const rows = Math.ceil(picked.length / SHEET_COLUMNS);
  const columns = Math.min(SHEET_COLUMNS, picked.length);
  const contactSheet = join(reviewDir, "contact-sheet.png");
  await runFfmpeg(
    ["-framerate", "1", "-i", join(workDir, "sheet-%04d.png"), "-vf", `scale=${SHEET_THUMB_WIDTH}:-2,tile=${columns}x${rows}:padding=4:margin=4:color=${BORDER_COLOR}`, "-frames:v", "1", contactSheet],
    ws.logPath,
  );
  return { contactSheet, sheetFrames: picked.length, stepImages };
}

function concatList(ws: Workspace, frames: FrameRecord[], id: string): string {
  const quote = (p: string) => `'${p.replaceAll("'", "'\\''")}'`;
  const lines = ["ffconcat version 1.0"];
  for (const f of frames) lines.push(`file ${quote(framePath(ws, f, id))}`, `duration ${(f.durationMs / 1000).toFixed(3)}`);
  // The concat demuxer drops the duration of the last entry; the final file is repeated and the total length is pinned with -t.
  lines.push(`file ${quote(framePath(ws, frames[frames.length - 1]!, id))}`);
  return lines.join("\n") + "\n";
}

export interface RenderOptions {
  width: number | null;
  colors: number;
  budgetMb: number;
  mp4: string | null;
}

export interface RenderResult {
  gif: string;
  mp4: string | null;
  size: PngSize;
  gifWidth: number;
  gifBytes: number;
  durationMs: number;
  overBudget: boolean;
}

export function defaultMp4Path(scenarioName: string): string {
  return join(tmpdir(), "reel-mesh", `${scenarioName}.mp4`);
}

async function encodeAtomic(args: string[], format: string, finalPath: string, logPath: string): Promise<void> {
  const tmp = `${finalPath}.tmp`;
  mkdirSync(dirname(finalPath), { recursive: true });
  try {
    await runFfmpeg([...args, "-f", format, tmp], logPath);
    renameSync(tmp, finalPath);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export async function runRender(scenario: Scenario, options: RenderOptions, baseDir: string = process.cwd()): Promise<RenderResult> {
  const ws = workspaceOf(scenario, baseDir);
  const frames = readFrames(ws);
  const ids = screenIds(scenario, frames);
  const { filter, size } = stackFilter(sizesOf(ws, ids, frames[0]!), scenario.layout, "stacked");
  const durationMs = frames.reduce((sum, f) => sum + f.durationMs, 0);
  const workDir = join(ws.dir, "compose");
  mkdirSync(workDir, { recursive: true });

  const inputs: string[] = [];
  for (const id of ids) {
    const list = join(workDir, `concat-${id}.txt`);
    writeFileSync(list, concatList(ws, frames, id));
    inputs.push("-f", "concat", "-safe", "0", "-i", list);
  }
  const total = ["-t", (durationMs / 1000).toFixed(3)];
  const gifWidth = options.width ?? size.width;
  const scale = options.width === null ? "" : `,scale=${options.width}:-2:flags=lanczos`;
  const gifChain = `${filter};[stacked]fps=${GIF_FPS}${scale},split[a][b];[a]palettegen=max_colors=${options.colors}[p];[b][p]paletteuse=dither=bayer`;
  const gif = join(ws.dir, `${scenario.name}.gif`);
  await encodeAtomic([...inputs, "-filter_complex", gifChain, ...total], "gif", gif, ws.logPath);

  let mp4: string | null = null;
  if (options.mp4 !== null) {
    mp4 = resolve(options.mp4);
    const mp4Chain = `${filter};[stacked]fps=${GIF_FPS}${scale},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`;
    await encodeAtomic([...inputs, "-filter_complex", mp4Chain, ...total, "-c:v", "libx264", "-movflags", "+faststart"], "mp4", mp4, ws.logPath);
  }

  const gifBytes = statSync(gif).size;
  return { gif, mp4, size, gifWidth, gifBytes, durationMs, overBudget: gifBytes > options.budgetMb * 1024 * 1024 };
}

const MIN_COLORS = 32;
const MIN_WIDTH = 160;
const SHRINK_MARGIN = 0.9;

export function budgetSuggestion(result: RenderResult, options: RenderOptions, scenarioFile: string): string {
  const ratio = Math.sqrt((options.budgetMb * 1024 * 1024) / result.gifBytes) * SHRINK_MARGIN;
  const width = Math.max(MIN_WIDTH, Math.floor((result.gifWidth * Math.min(ratio, 0.9)) / 2) * 2);
  const colors = Math.max(MIN_COLORS, Math.floor(options.colors / 2));
  return `node ${CLI_PATH} render ${scenarioFile} --width ${width} --colors ${colors} --budget-mb ${options.budgetMb}`;
}
