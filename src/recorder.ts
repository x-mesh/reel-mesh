import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterFactory, BrowserAdapter, PageId } from "./browser/adapter.ts";
import { REMOVE_OVERLAY_EXPRESSION, showOverlayExpression } from "./overlay.ts";
import {
  EXIT_RESTORE_DIFF,
  EXIT_SNAPSHOT_LEFT,
  captureSnapshot,
  clearState,
  hasSnapshot,
  hasStatePatterns,
  leftoverSnapshotMessage,
  restoreState,
} from "./state.ts";
import type { StateSnapshot } from "./state.ts";
import { EXIT_PRECHECK_FAILED, PinError, TARGET_RESOLVER_SOURCE, describeTarget, launchOptions, openVerifiedPanel } from "./precheck.ts";
import { withTimeout } from "./runlog.ts";
import type { RunLog } from "./runlog.ts";
import type { Action, Expectation, Scenario, Screen, Step, Target } from "./scenario.ts";

const NO_PROGRESS_MS = 10000;
const HANG_GRACE_MS = 10000;
const POLL_MS = 50;
const BROWSER_TIMEOUT_MS = 30000;
const CLEANUP_TIMEOUT_MS = 5000;

interface Point {
  x: number;
  y: number;
}

interface Located {
  count: number;
  visible: boolean;
  x: number;
  y: number;
}

interface PendingFrame {
  durationMs: number;
  shots: Map<string, Uint8Array>;
}

interface Attempt {
  frames: PendingFrame[];
  extendMs: number;
}

export interface FrameRecord {
  index: number;
  step: number;
  durationMs: number;
  screens: Record<string, string>;
}

export interface RecordResult {
  code: number;
  frames: FrameRecord[];
  framesPath: string | null;
  pages: Map<string, PageId>;
}

export interface ScriptContext {
  evaluate<A, T>(screenId: string, fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const pad = (n: number) => String(n).padStart(4, "0");

// Resolves a Target to the viewport point of its center. A target inside a scaled iframe is mapped through
// the frame's getBoundingClientRect() ratio against its layout size; nested frames repeat the mapping upward.
function locateExpression(target: Target): string {
  return `(() => {
  ${TARGET_RESOLVER_SOURCE}
  const els = __reelFind(document, ${JSON.stringify(target)});
  if (els.length !== 1) return { count: els.length, visible: false, x: 0, y: 0 };
  const el = els[0];
  el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  const r = el.getBoundingClientRect();
  let x = r.left + r.width / 2;
  let y = r.top + r.height / 2;
  let win = el.ownerDocument.defaultView;
  while (win && win.frameElement) {
    const f = win.frameElement;
    const fr = f.getBoundingClientRect();
    const sx = f.offsetWidth ? fr.width / f.offsetWidth : 1;
    const sy = f.offsetHeight ? fr.height / f.offsetHeight : 1;
    x = fr.left + (f.clientLeft + x) * sx;
    y = fr.top + (f.clientTop + y) * sy;
    win = win.parent;
  }
  return { count: 1, visible: r.width > 0 && r.height > 0, x, y };
})()`;
}

function focusedExpression(target: Target): string {
  return `(() => {
  ${TARGET_RESOLVER_SOURCE}
  const els = __reelFind(document, ${JSON.stringify(target)});
  return els.length === 1 && els[0].getRootNode().activeElement === els[0];
})()`;
}

// Ease-out cubic: the pointer decelerates into the target. Fixed steps keep the frame count independent of distance.
function pointerPath(from: Point, to: Point, steps: number): Point[] {
  const path: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const eased = 1 - (1 - i / steps) ** 3;
    path.push({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased });
  }
  return path;
}

function expectationOf(step: Step): Expectation | null {
  if (step.action.kind === "expect") return { screen: step.action.screen, selector: step.action.selector };
  return step.expect;
}

// goto, input and pointer actions end with one frame taken after the expected state holds; the rest add no trailing frame.
const hasTailFrame = (action: Action): boolean => action.kind !== "expect" && action.kind !== "wait";

class Recorder {
  readonly pages = new Map<string, PageId>();
  readonly frames: FrameRecord[] = [];
  #scenario: Scenario;
  #adapter: BrowserAdapter;
  #log: RunLog;
  #outDir: string;
  #progress: () => void;
  #pointers = new Map<string, Point>();
  #caption: string | null = null;
  #active: string;
  #maskMatched = new Set<string>();

  constructor(scenario: Scenario, adapter: BrowserAdapter, log: RunLog, progress: () => void) {
    this.#scenario = scenario;
    this.#adapter = adapter;
    this.#log = log;
    this.#outDir = dirname(log.path);
    this.#progress = progress;
    this.#active = scenario.screens[0]?.id ?? "";
  }

  get framesPath(): string {
    return join(this.#outDir, "frames.json");
  }

  lastFramePath(): string | null {
    const rel = this.frames.at(-1)?.screens[this.#active];
    return rel === undefined ? null : join(this.#outDir, rel);
  }

  async prepare(): Promise<void> {
    await rm(join(this.#outDir, "frames"), { recursive: true, force: true });
    await rm(this.framesPath, { force: true });
    await mkdir(join(this.#outDir, "frames"), { recursive: true });
    // URL screens open first: a pinned panel needs its target tab to exist.
    for (const screen of this.#scenario.screens) {
      if (screen.url === null) continue;
      const page = await this.#adapter.openPage();
      this.pages.set(screen.id, page);
      await this.#adapter.setViewport(page, screen.width, screen.height, screen.scale);
      await this.#adapter.goto(page, screen.url);
    }
    for (const screen of this.#scenario.screens) {
      if (screen.extension) this.pages.set(screen.id, await this.#openExtensionScreen(screen));
    }
    this.#log.line("setup", "ok", 0);
    this.#progress();
  }

  async #openExtensionScreen(screen: Screen): Promise<PageId> {
    const { extension } = screen;
    if (!extension) throw new Error(`화면 '${screen.id}'에 URL이나 확장이 없습니다`);
    const id = await this.#adapter.findExtensionId(extension.name);
    if (id === null) throw new Error(`확장 '${extension.name}'을 찾지 못했습니다 (check 명령으로 점검하세요)`);
    let panel: PageId;
    if (extension.pinTo === null) {
      panel = await this.#adapter.openExtensionPage(id, extension.page, null);
    } else {
      const target = this.#scenario.screens.find((s) => s.id === extension.pinTo);
      const targetPage = target?.url == null ? undefined : this.pages.get(target.id);
      if (targetPage === undefined) throw new PinError(`화면 '${screen.id}'의 pinTo '${extension.pinTo}'는 URL이 있는 화면이 아닙니다`);
      panel = await openVerifiedPanel(this.#adapter, id, extension.page, targetPage).catch((e) => {
        throw e instanceof PinError ? new PinError(`화면 '${screen.id}': ${e.message}`) : e;
      });
    }
    await this.#adapter.setViewport(panel, screen.width, screen.height, screen.scale);
    return panel;
  }

  async removeOverlays(): Promise<void> {
    for (const [id, page] of this.pages) {
      try {
        await withTimeout("오버레이 제거", CLEANUP_TIMEOUT_MS, () => this.#adapter.evaluate(page, REMOVE_OVERLAY_EXPRESSION));
      } catch (e) {
        this.#log.line("overlay", `remove failed on ${id}: ${message(e)}`, this.frames.length);
      }
    }
  }

  reportUnmatchedMasks(write: (line: string) => void): void {
    if (this.#maskMatched.size === 0 && this.frames.length === 0) return;
    for (const selector of this.#scenario.mask) {
      if (this.#maskMatched.has(selector)) continue;
      this.#log.line("mask", `warn no match ${selector}`, this.frames.length);
      write(`WARN mask '${selector}'가 녹화 동안 한 번도 일치하지 않았습니다`);
    }
  }

  async writeFrames(): Promise<void> {
    await writeFile(this.framesPath, JSON.stringify(this.frames, null, 2));
  }

  async runStep(step: Step, n: number): Promise<void> {
    const { action } = step;
    const label = `step ${n} ${action.kind}`;
    const timeoutMs = this.#scenario.timing.stepTimeoutMs;
    const attempts = step.retry + 1;
    const expectation = expectationOf(step);
    const startPointers = new Map(this.#pointers);
    const limit = timeoutMs + HANG_GRACE_MS + (action.kind === "wait" ? action.ms : 0);
    this.#log.line(label, "start", this.frames.length);
    this.#progress();

    for (let attempt = 1; attempt <= attempts; attempt++) {
      this.#pointers = new Map(startPointers);
      const pending: Attempt = { frames: [], extendMs: 0 };
      const deadline = Date.now() + timeoutMs;
      await withTimeout(label, limit, () => this.#perform(action, pending, deadline));
      if (expectation && !(await this.#holds(expectation, Math.floor(timeoutMs / attempts)))) {
        if (attempt === attempts) {
          throw new Error(`'${expectation.selector}'(화면 '${expectation.screen}')가 ${attempts}번 시도 뒤에도 나타나지 않았습니다`);
        }
        this.#log.line(label, `retry ${attempt}/${step.retry}`, this.frames.length);
        continue;
      }
      if (hasTailFrame(action)) await this.#capture(pending, this.#scenario.timing.frameMs);
      await this.#commit(n, pending);
      this.#log.line(label, `ok retries=${attempt - 1}`, this.frames.length);
      this.#progress();
      return;
    }
  }

  #page(screen: string): PageId {
    const page = this.pages.get(screen);
    if (page === undefined) throw new Error(`알 수 없는 화면 '${screen}'`);
    return page;
  }

  async #holds(expectation: Expectation, budgetMs: number): Promise<boolean> {
    const page = this.#page(expectation.screen);
    const expression = `document.querySelectorAll(${JSON.stringify(expectation.selector)}).length > 0`;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const found = await withTimeout("expect", this.#scenario.timing.stepTimeoutMs, () => this.#adapter.evaluate<boolean>(page, expression));
      if (found) return true;
      if (Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  }

  async #locate(screen: string, target: Target, deadline: number): Promise<Point> {
    const page = this.#page(screen);
    const expression = locateExpression(target);
    const name = describeTarget(target);
    for (;;) {
      const found = await this.#adapter.evaluate<Located>(page, expression);
      if (found.count > 1) throw new Error(`대상 '${name}'가 화면 '${screen}'에서 ${found.count}개 일치합니다 (1개여야 합니다)`);
      if (found.count === 1 && found.visible) return { x: found.x, y: found.y };
      if (Date.now() >= deadline) {
        const why = found.count === 0 ? "찾지 못했습니다" : "보이지 않습니다";
        throw new Error(`대상 '${name}'를 화면 '${screen}'에서 ${why} (${this.#scenario.timing.stepTimeoutMs}ms 대기)`);
      }
      await sleep(POLL_MS);
    }
  }

  async #movePointer(screenId: string, to: Point, attempt: Attempt): Promise<void> {
    const screen = this.#scenario.screens.find((s) => s.id === screenId);
    const page = this.#page(screenId);
    const from = this.#pointers.get(screenId) ?? { x: (screen?.width ?? 0) / 2, y: (screen?.height ?? 0) / 2 };
    const { pointerSteps, pointerStepMs } = this.#scenario.timing;
    for (const point of pointerPath(from, to, pointerSteps)) {
      await this.#adapter.mouseMove(page, point.x, point.y);
      this.#pointers.set(screenId, point);
      await this.#capture(attempt, pointerStepMs);
    }
  }

  async #perform(action: Action, attempt: Attempt, deadline: number): Promise<void> {
    switch (action.kind) {
      case "goto":
        await this.#adapter.goto(this.#page(action.screen), action.url);
        return;
      case "click":
      case "dblclick": {
        const to = await this.#locate(action.screen, action.target, deadline);
        await this.#movePointer(action.screen, to, attempt);
        const page = this.#page(action.screen);
        await this.#adapter.mouseClick(page, to.x, to.y, 1);
        if (action.kind === "dblclick") await this.#adapter.mouseClick(page, to.x, to.y, 2);
        return;
      }
      case "drag": {
        const page = this.#page(action.screen);
        const from = await this.#locate(action.screen, action.from, deadline);
        await this.#movePointer(action.screen, from, attempt);
        await this.#adapter.mouseDown(page);
        const to = await this.#locate(action.screen, action.to, deadline);
        await this.#movePointer(action.screen, to, attempt);
        await this.#adapter.mouseUp(page);
        return;
      }
      case "type": {
        await this.#locate(action.screen, action.target, deadline);
        const page = this.#page(action.screen);
        if (!(await this.#adapter.evaluate<boolean>(page, focusedExpression(action.target)))) {
          throw new Error(`대상 '${describeTarget(action.target)}'가 포커스를 받지 못했습니다 (입력 전에 클릭 등으로 포커스를 주세요)`);
        }
        await this.#adapter.keyboardType(page, action.text);
        return;
      }
      case "press":
        await this.#adapter.keyboardPress(this.#page(action.screen), action.key);
        return;
      case "wait":
        await sleep(action.ms);
        if (this.frames.length === 0 && attempt.frames.length === 0) await this.#capture(attempt, action.ms);
        else attempt.extendMs = action.ms;
        return;
      case "caption":
        this.#caption = action.text;
        return;
      case "screen":
        this.#page(action.screen);
        this.#active = action.screen;
        return;
      case "expect":
        return;
      case "script":
        await this.#runScript(action.path);
        return;
    }
  }

  async #runScript(path: string): Promise<void> {
    const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
    if (typeof module.default !== "function") throw new Error(`스크립트 '${path}'에 default 함수가 없습니다`);
    const context: ScriptContext = {
      evaluate: (screenId, fn, arg) => {
        const literal = arg === undefined ? "undefined" : JSON.stringify(arg);
        return this.#adapter.evaluate(this.#page(screenId), `(${fn.toString()})(${literal})`);
      },
    };
    await module.default(context);
  }

  async #capture(attempt: Attempt, durationMs: number): Promise<void> {
    const shots = new Map<string, Uint8Array>();
    await Promise.all(
      this.#scenario.screens.map(async (screen) => {
        const page = this.#page(screen.id);
        const matched = await this.#adapter.evaluate<string[]>(
          page,
          showOverlayExpression({
            cursor: this.#pointers.get(screen.id) ?? null,
            caption: screen.id === this.#active ? this.#caption : null,
            captionPosition: this.#scenario.caption.position[screen.id] ?? "bottom",
            masks: this.#scenario.mask,
          }),
        );
        for (const selector of matched) this.#maskMatched.add(selector);
        shots.set(screen.id, await this.#adapter.screenshot(page));
      }),
    );
    attempt.frames.push({ durationMs, shots });
    this.#progress();
  }

  async #commit(step: number, attempt: Attempt): Promise<void> {
    for (const frame of attempt.frames) {
      const index = this.frames.length;
      const screens: Record<string, string> = {};
      for (const screen of this.#scenario.screens) {
        const shot = frame.shots.get(screen.id);
        if (shot === undefined) throw new Error(`프레임 ${index}에 화면 '${screen.id}' 캡처가 없습니다`);
        const rel = join("frames", `${pad(index)}-${screen.id}.png`);
        await writeFile(join(this.#outDir, rel), shot);
        screens[screen.id] = rel;
      }
      this.frames.push({ index, step, durationMs: frame.durationMs, screens });
    }
    const last = this.frames.at(-1);
    if (attempt.extendMs > 0 && last) last.durationMs += attempt.extendMs;
  }
}

function startWatchdog(write: (line: string) => void): { progress: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | undefined;
  let fired = false;
  const arm = () => {
    clearTimeout(timer);
    if (fired) return;
    timer = setTimeout(() => {
      fired = true;
      write(
        `${NO_PROGRESS_MS / 1000}초 동안 진행이 없습니다. 원인 후보: 브라우저 연결이 끊겼거나, 개발 서버가 응답하지 않거나, 사용자가 브라우저 제어를 가져갔습니다.`,
      );
    }, NO_PROGRESS_MS);
    timer.unref();
  };
  arm();
  return { progress: arm, stop: () => clearTimeout(timer) };
}

// The caller owns the adapter: pages stay open after the run so callers can inspect them, and the overlay is removed even on failure.
export async function recordScenario(
  scenario: Scenario,
  adapter: BrowserAdapter,
  log: RunLog,
  write: (line: string) => void = console.log,
): Promise<RecordResult> {
  const outDir = dirname(log.path);
  if (hasSnapshot(outDir)) {
    for (const line of leftoverSnapshotMessage(scenario, outDir)) write(line);
    log.line("state", "leftover snapshot", 0);
    return { code: EXIT_SNAPSHOT_LEFT, frames: [], framesPath: null, pages: new Map() };
  }
  const watchdog = startWatchdog(write);
  const recorder = new Recorder(scenario, adapter, log, watchdog.progress);
  let code = 0;
  let snapshot: StateSnapshot | null = null;
  try {
    let stage = "setup";
    try {
      if (hasStatePatterns(scenario)) {
        stage = "state snapshot";
        snapshot = await captureSnapshot(scenario, adapter, outDir);
        await clearState(scenario, adapter, snapshot);
        stage = "setup";
      }
      await recorder.prepare();
      for (const [i, step] of scenario.steps.entries()) {
        stage = `step ${i + 1} ${step.action.kind}`;
        await recorder.runStep(step, i + 1);
      }
      await recorder.writeFrames();
      log.line("record", "done", recorder.frames.length);
      write(`recorded ${recorder.frames.length} frames: ${recorder.framesPath}`);
    } catch (e) {
      code = e instanceof PinError ? EXIT_PRECHECK_FAILED : 1;
      log.line(stage, `fail ${message(e)}`, recorder.frames.length);
      write(`FAIL ${stage}: ${message(e)}`);
      write(`last frame: ${recorder.lastFramePath() ?? "(없음)"}`);
      write(`log: ${log.path}`);
    }
  } finally {
    watchdog.stop();
    recorder.reportUnmatchedMasks(write);
    await recorder.removeOverlays();
    if (snapshot !== null) {
      const report = await restoreState(scenario, adapter, snapshot, recorder.pages, outDir, log, write);
      if (!report.equal) code = EXIT_RESTORE_DIFF;
    }
  }
  return { code, frames: recorder.frames, framesPath: code === 0 ? recorder.framesPath : null, pages: recorder.pages };
}

export async function runRecord(scenario: Scenario, log: RunLog, createAdapter: AdapterFactory, write: (line: string) => void = console.log): Promise<number> {
  const adapter = createAdapter();
  try {
    try {
      await withTimeout("브라우저 실행", BROWSER_TIMEOUT_MS, () => adapter.launch(launchOptions(scenario)));
    } catch (e) {
      log.line("setup", `fail ${message(e)}`, 0);
      write(`FAIL setup: 브라우저를 실행하지 못했습니다 (${message(e)})`);
      write(`log: ${log.path}`);
      return 1;
    }
    return (await recordScenario(scenario, adapter, log, write)).code;
  } finally {
    await withTimeout("브라우저 종료", BROWSER_TIMEOUT_MS, () => adapter.close()).catch((e) => log.line("record:브라우저 종료", `fail ${message(e)}`, 0));
  }
}
