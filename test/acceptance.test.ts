import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import { launchOptions } from "../src/precheck.ts";
import { recordScenario } from "../src/recorder.ts";
import type { FrameRecord } from "../src/recorder.ts";
import { loadScenario } from "../src/scenario.ts";
import { openRunLog } from "../src/runlog.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const examples = fileURLToPath(new URL("../examples", import.meta.url));
const EXT_NAME = "reel-mesh-fixture-ext";
const WHOLE_FLOW_LIMIT_MS = 180000;
const CHECK_FAIL_LIMIT_MS = 30000;
const GIF_BUDGET_BYTES = 3 * 1024 * 1024;
const EXIT_PRECHECK = 3;
const FAST_TIMING = "{ stepTimeoutMs: 2000, pointerSteps: 3, pointerStepMs: 20, frameMs: 100 }";
const LOG_KEY = "fixture:log:a";
const DOCK_KEY = "fixture:dockHeight";

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

function cli(args: string[], cwd: string): Promise<Cli> {
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, timeout: 170000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function probe(path: string, entries: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=nw=1", path], (error, stdout) => {
      if (error) return reject(error);
      resolve(Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=") as [string, string])));
    });
  });
}

const readFrames = async (workDir: string, name: string): Promise<FrameRecord[]> =>
  JSON.parse(await readFile(join(workDir, ".reel", name, "frames.json"), "utf8")) as FrameRecord[];
const totalMs = (frames: FrameRecord[]) => frames.reduce((sum, f) => sum + f.durationMs, 0);

describe("fixture acceptance (two screens)", () => {
  let server: FixtureServer;
  let dir: string;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-accept-"));
    await cp(join(examples, "fixture-ext"), join(dir, "fixture-ext"), { recursive: true });
    await cp(join(examples, "scenarios", "scripts"), join(dir, "scripts"), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function scenarioFile(edit: (text: string) => string = (t) => t, name = "fixture-ext.yaml", url = server.url): Promise<string> {
    const text = (await readFile(join(examples, "scenarios", "fixture-ext.yaml"), "utf8"))
      .replace("http://127.0.0.1:5173", url)
      .replace("../fixture-ext", "./fixture-ext");
    const path = join(dir, name);
    await writeFile(path, edit(text));
    return path;
  }

  it("runs validate, check, record, review, render in 180s and makes a 1402x760 GIF (DONE-2)", async (t) => {
    const path = await scenarioFile();
    const validate = await cli(["validate", path], dir);
    assert.equal(validate.code, 0, validate.stderr);

    const started = Date.now();
    const check = await cli(["check", path], dir);
    assert.equal(check.code, 0, check.stdout + check.stderr);
    const record = await cli(["record", path], dir);
    assert.equal(record.code, 0, record.stdout + record.stderr);
    const render = await cli(["render", path], dir);
    assert.equal(render.code, 0, render.stdout + render.stderr);
    const flowMs = Date.now() - started;

    const out = join(dir, ".reel", "fixture-ext");
    const gif = join(out, "fixture-ext.gif");
    const info = await probe(gif, "stream=width,height,avg_frame_rate,r_frame_rate,nb_frames");
    const { size } = await stat(gif);
    const frames = await readFrames(dir, "fixture-ext");
    t.diagnostic(`check->render ${(flowMs / 1000).toFixed(1)}s (check ${check.ms}ms, record ${record.ms}ms, render ${render.ms}ms)`);
    t.diagnostic(`GIF ${info.width}x${info.height}, ${(size / 1024).toFixed(0)}KB, r_frame_rate ${info.r_frame_rate}, gif frames ${info.nb_frames}, recorded frames ${frames.length}, durationMs sum ${totalMs(frames)}`);
    assert.ok(flowMs < WHOLE_FLOW_LIMIT_MS, `flow took ${flowMs}ms`);
    assert.equal(info.width, "1402");
    assert.equal(info.height, "760");
    assert.ok(size <= GIF_BUDGET_BYTES, `GIF is ${size} bytes`);
    assert.match(info.r_frame_rate ?? "", /^15\/1$/);

    const reviewRun = await cli(["review", path], dir);
    assert.equal(reviewRun.code, 0, reviewRun.stdout + reviewRun.stderr);
    assert.ok(existsSync(join(out, "review", "contact-sheet.png")));
    const stepImages = frames.map((f) => f.step).filter((step, i, all) => all.indexOf(step) === i);
    for (const step of stepImages) assert.ok(existsSync(join(out, "review", `step-${step}.png`)), `step-${step}.png`);

    const denyFile = join(dir, "deny.txt");
    await writeFile(denyFile, "SECRET-NOT-IN-FRAMES\n");
    const audit = await cli(["audit", path, "--deny-file", denyFile], dir);
    assert.equal(audit.code, 0, audit.stdout + audit.stderr);
  });

  it("records the same frame count and durationMs sum twice (DONE-6, two screens)", async (t) => {
    const path = await scenarioFile();
    const runs: FrameRecord[][] = [];
    for (let i = 0; i < 2; i++) {
      const workDir = await mkdtemp(join(tmpdir(), "reel-mesh-accept-det-"));
      try {
        const record = await cli(["record", path], workDir);
        assert.equal(record.code, 0, record.stdout + record.stderr);
        runs.push(await readFrames(workDir, "fixture-ext"));
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    }
    t.diagnostic(`runs: frames ${runs[0]!.length}/${runs[1]!.length}, durationMs sum ${totalMs(runs[0]!)}/${totalMs(runs[1]!)}`);
    assert.ok(runs[0]!.length > 0);
    assert.equal(runs[0]!.length, runs[1]!.length);
    assert.equal(totalMs(runs[0]!), totalMs(runs[1]!));
  });

  it("fails check with exit 3 within 30s when the server is down", async (t) => {
    const stopped = await startFixtureServer();
    const deadUrl = stopped.url;
    await stopped.stop();
    const path = await scenarioFile((text) => text, "down.yaml", deadUrl);
    const check = await cli(["check", path], dir);
    t.diagnostic(`check with server down: exit ${check.code} in ${check.ms}ms`);
    assert.equal(check.code, EXIT_PRECHECK, check.stdout + check.stderr);
    assert.ok(check.ms < CHECK_FAIL_LIMIT_MS, `check took ${check.ms}ms`);
  });
});

describe("fixture acceptance: stored values (DONE-3, F6, F7, F8)", () => {
  let server: FixtureServer;
  let adapter: PlaywrightAdapter;
  let dir: string;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server?.stop();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-accept-state-"));
    await cp(join(examples, "fixture-ext"), join(dir, "fixture-ext"), { recursive: true });
    await cp(join(examples, "scenarios", "scripts"), join(dir, "scripts"), { recursive: true });
    adapter = new PlaywrightAdapter();
  });
  afterEach(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function scenarioFile(edit: (text: string) => string = (t) => t): Promise<string> {
    const text = (await readFile(join(examples, "scenarios", "fixture-ext.yaml"), "utf8"))
      .replace("http://127.0.0.1:5173", server.url)
      .replace("../fixture-ext", "./fixture-ext")
      .replace(/timing: .*/, `timing: ${FAST_TIMING}`)
      .replace(
        "state:\n  chromeStorage: [\"dock*\"]",
        `state:\n  localStorage: ["fixture:*"]\n  chromeStorage: ["dock*"]\n  restoreViaBlankOrigin: true\n  blankPath: /blank.html`,
      )
      .replace(
        "steps:\n",
        `steps:\n  - expect: { screen: page, selector: '#log[data-log-count="0"]' }\n  - click: { screen: page, target: "#log-button" }\n    expect: { screen: page, selector: '#log[data-log-count="1"]' }\n`,
      );
    const path = join(dir, "state.yaml");
    await writeFile(path, edit(text));
    return path;
  }

  async function onPage<T>(work: (page: string) => Promise<T>): Promise<T> {
    const page = await adapter.openPage();
    try {
      await adapter.goto(page, `${server.url}/blank.html`);
      return await work(page);
    } finally {
      await adapter.closePage(page);
    }
  }
  async function onPanel<T>(work: (page: string) => Promise<T>): Promise<T> {
    const id = await adapter.findExtensionId(EXT_NAME);
    assert.ok(id);
    const page = await adapter.openExtensionPage(id, "panel.html", null);
    try {
      return await work(page);
    } finally {
      await adapter.closePage(page);
    }
  }
  const localValues = () =>
    onPage((page) => adapter.evaluate<Record<string, string>>(page, `Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]))`));
  const chromeValues = () => onPanel((page) => adapter.evaluate<Record<string, unknown>>(page, `chrome.storage.local.get(null)`));

  async function seed() {
    const local = { [DOCK_KEY]: "500", [LOG_KEY]: '["old"]', "other:key": "kept" };
    await onPage((page) => adapter.evaluate(page, `(() => { for (const [k, v] of Object.entries(${JSON.stringify(local)})) localStorage.setItem(k, v); })()`));
    await onPanel((page) => adapter.evaluate(page, `chrome.storage.local.set({ dockHeight: 500, "other:key": "kept" })`));
    return { local, chrome: { dockHeight: 500, "other:key": "kept" } };
  }

  async function record(path: string) {
    const scenario = loadScenario(path);
    const result = await recordScenario(scenario, adapter, openRunLog(scenario.name, dir), () => undefined);
    const outDir = join(dir, ".reel", scenario.name);
    const report = JSON.parse(await readFile(join(outDir, "state-restore.json"), "utf8")) as { equal: boolean; diffs: unknown[] };
    return { result, outDir, report };
  }

  it("keeps localStorage and chrome.storage after a forced error (DONE-3, F7)", async (t) => {
    const path = await scenarioFile((text) => text.replace("  - wait: 400", "  - script: scripts/throw.js"));
    await adapter.launch(launchOptions(loadScenario(path)));
    const before = await seed();

    const { result, outDir, report } = await record(path);
    t.diagnostic(`forced error: exit ${result.code}, restore equal ${report.equal}`);
    assert.equal(result.code, 1);
    assert.equal(report.equal, true);
    assert.deepEqual(await localValues(), before.local);
    assert.deepEqual(await chromeValues(), before.chrome);
    assert.equal(existsSync(join(outDir, "state-snapshot.json")), false);
  });

  it("starts the second record without the previous log (F6) and restores via the blank origin (F8)", async (t) => {
    const path = await scenarioFile();
    await adapter.launch(launchOptions(loadScenario(path)));
    const before = await seed();

    for (let i = 1; i <= 2; i++) {
      const { result, report } = await record(path);
      t.diagnostic(`record ${i}: exit ${result.code}, ${result.frames.length} frames, restore equal ${report.equal}`);
      assert.equal(result.code, 0, `record ${i}`);
      assert.ok(result.frames.length > 0);
      assert.equal(report.equal, true);
      assert.deepEqual(await localValues(), before.local);
      assert.deepEqual(await chromeValues(), before.chrome);
    }
  });

  it("reports a difference when the blank origin is off (F8 negative control)", async () => {
    const path = await scenarioFile((text) => text.replace("restoreViaBlankOrigin: true", "restoreViaBlankOrigin: false"));
    await adapter.launch(launchOptions(loadScenario(path)));
    await seed();
    const { result, report } = await record(path);
    assert.equal(result.code, 4);
    assert.equal(report.equal, false);
  });
});
