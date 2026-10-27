import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EgoBrowserAdapter } from "../src/browser/ego-browser.ts";
import { openRunLog } from "../src/runlog.ts";
import { startFixtureServer, writeTempScenario } from "./helpers.ts";

const fake = fileURLToPath(new URL("./fixtures/fake-ego-browser.ts", import.meta.url));
const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));

interface Call {
  pid: number;
  call: string;
  space?: number;
  page?: string;
  [key: string]: unknown;
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reel-mesh-fake-ego-"));
  process.env.FAKE_EGO_DIR = dir;
});

afterEach(async () => {
  delete process.env.FAKE_EGO_DIR;
  await rm(dir, { recursive: true, force: true });
});

async function calls(): Promise<Call[]> {
  const path = join(dir, "calls.jsonl");
  if (!existsSync(path)) return [];
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Call);
}

const without = (all: Call[], ...names: string[]) => all.filter((c) => !names.includes(c.call));

describe("EgoBrowserAdapter with a fake ego-browser", () => {
  it("one process per call, reusing the task space by id and the first page as p1", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await adapter.launch();
    const first = await adapter.openPage();
    const second = await adapter.openPage();
    await adapter.goto(first, "http://127.0.0.1:1/");
    await adapter.close();
    assert.deepEqual([first, second], ["p1", "p2"]);
    const all = await calls();
    const spaceCalls = all.filter((c) => c.call === "taskSpace");
    assert.equal(spaceCalls[0]?.space, 1);
    assert.match(String(spaceCalls[0]?.argument), /^reel-mesh-/);
    for (const c of spaceCalls.slice(1)) assert.equal(c.argument, 1, "later rounds resume by numeric id");
    assert.equal(new Set(all.map((c) => c.pid)).size, spaceCalls.length, "each call runs in its own process");
  });

  it("splits notice lines from the result, ignores a result line with the wrong token, and reports the update once", async () => {
    const log = openRunLog("notice", dir);
    const written: string[] = [];
    await writeFile(join(dir, "evaluate.json"), JSON.stringify({ answer: 42 }));
    const adapter = new EgoBrowserAdapter({ executable: fake, log, write: (line) => written.push(line) });
    await adapter.launch();
    const page = await adapter.openPage();
    const value = await adapter.evaluate<{ answer: number }>(page, "({ answer: 42 })");
    await adapter.close();
    assert.deepEqual(value, { answer: 42 });
    const runLog = await readFile(log.path, "utf8");
    assert.match(runLog, /ego-browser:notice\t\[ego-browser:notice\] Ego Lite 2\.9\.9 is available/);
    assert.doesNotMatch(runLog, /spoofed|plain noise/);
    assert.equal(written.length, 1);
    assert.match(written[0]!, /Ego Lite 2\.9\.9 is available.*upgrade/);
  });

  it("clicks once then twice: mouse.click first, then Input events carrying clickCount 2", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await adapter.launch();
    const page = await adapter.openPage();
    await adapter.mouseClick(page, 10, 20, 1);
    await adapter.mouseClick(page, 10, 20, 2);
    await adapter.close();
    const sequence = without(await calls(), "taskSpace", "task.finish");
    assert.deepEqual(
      sequence.map((c) => [c.call, c.method ?? null, (c.params as { type?: string; clickCount?: number } | undefined)?.type ?? null]),
      [
        ["mouse.click", null, null],
        ["mouse.move", null, null],
        ["page.cdp", "Input.dispatchMouseEvent", "mousePressed"],
        ["page.cdp", "Input.dispatchMouseEvent", "mouseReleased"],
      ],
    );
    assert.equal((sequence[2]!.params as { clickCount: number }).clickCount, 2);
    assert.equal((sequence[3]!.params as { clickCount: number }).clickCount, 2);
  });

  it("pins the screen size through page.cdp Emulation.setDeviceMetricsOverride", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await adapter.launch();
    const page = await adapter.openPage();
    await adapter.setViewport(page, 800, 600, 2);
    await adapter.close();
    const cdp = (await calls()).find((c) => c.call === "page.cdp");
    assert.equal(cdp?.method, "Emulation.setDeviceMetricsOverride");
    assert.deepEqual(cdp?.params, { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
  });

  it("returns screenshot bytes read from the path it handed to ego-browser", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await adapter.launch();
    const page = await adapter.openPage();
    const bytes = await adapter.screenshot(page);
    await adapter.close();
    assert.deepEqual([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    const shot = (await calls()).find((c) => c.call === "page.screenshot");
    assert.equal(existsSync(String(shot?.path)), false, "temporary screenshot is removed");
  });

  it("closes only pages it opened and calls finish({ keep: [] }) exactly once", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await adapter.launch();
    const page = await adapter.openPage();
    await assert.rejects(adapter.closePage("p9"), /unknown page: p9/);
    await adapter.closePage(page);
    await assert.rejects(adapter.goto(page, "http://127.0.0.1:1/"), /unknown page/);
    await adapter.close();
    await adapter.close();
    const all = await calls();
    assert.equal(all.filter((c) => c.call === "page.close").length, 1);
    const finishes = all.filter((c) => c.call === "task.finish");
    assert.equal(finishes.length, 1);
    assert.deepEqual(finishes[0]?.keep, []);
  });

  it("fails with unsupported: for extension features and non-left buttons without running ego-browser", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake });
    await assert.rejects(adapter.launch({ extensionPaths: ["/x"] }), /^Error: unsupported: launch — /);
    assert.deepEqual(await calls(), []);
    await adapter.launch();
    const page = await adapter.openPage();
    await assert.rejects(adapter.findExtensionId("x"), /unsupported: findExtensionId — /);
    await assert.rejects(adapter.openExtensionPage("id", "panel.html", null), /unsupported: openExtensionPage — /);
    await assert.rejects(adapter.tabIdOf("id", "panel.html", page), /unsupported: tabIdOf — /);
    await assert.rejects(adapter.mouseDown(page, "right"), /unsupported: mouseDown — /);
    await adapter.close();
  });

  it("fails a call quickly with cause candidates when the process exits without a result", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake, timeoutMs: 5000 });
    await adapter.launch();
    const page = await adapter.openPage();
    await writeFile(join(dir, "mode"), "die");
    const started = Date.now();
    await assert.rejects(adapter.goto(page, "http://127.0.0.1:1/"), (error: Error) => {
      assert.match(error.message, /결과 없이 끝났습니다 \(종료 코드 3\)/);
      assert.match(error.message, /browser control was taken by the user/);
      assert.match(error.message, /원인 후보: .*사용자가 브라우저 제어를 가져갔/);
      return true;
    });
    assert.ok(Date.now() - started < 4000);
    await writeFile(join(dir, "mode"), "ok");
    await adapter.close();
  });

  it("kills an unresponsive process at the time limit and names the cause candidates", async () => {
    const adapter = new EgoBrowserAdapter({ executable: fake, timeoutMs: 800 });
    await adapter.launch();
    const page = await adapter.openPage();
    await writeFile(join(dir, "mode"), "hang");
    const started = Date.now();
    await assert.rejects(adapter.goto(page, "http://127.0.0.1:1/"), /800ms 안에 응답하지 않아.*원인 후보: .*사용자가 브라우저 제어를 가져갔/);
    assert.ok(Date.now() - started < 4000);
    const hung = (await calls()).find((c) => c.call === "hang");
    assert.ok(hung);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    assert.throws(() => process.kill(hung.pid, 0), "hung fake process is gone");
    await writeFile(join(dir, "mode"), "ok");
    await adapter.close();
  });

  it("reports a missing executable by name", async () => {
    const adapter = new EgoBrowserAdapter({ executable: join(dir, "no-such-ego-browser") });
    await assert.rejects(adapter.launch(), /실행 파일을 찾지 못했습니다/);
  });
});

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

// PATH holds only a directory with the fake as `ego-browser` and node's own directory, so a real ego-browser cannot be found.
async function cli(args: string[], cwd: string, path: string): Promise<Cli> {
  return await new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, timeout: 60000, env: { ...process.env, PATH: path } }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stdout, stderr });
    });
  });
}

describe("reel-mesh --adapter", () => {
  let work: string;
  let path: string;

  beforeEach(async () => {
    work = await mkdtemp(join(tmpdir(), "reel-mesh-ego-cli-"));
    const shim = join(work, "shim");
    await mkdir(shim);
    await symlink(fake, join(shim, "ego-browser"));
    // The precheck runs for every adapter and needs ffmpeg, but the real PATH may also hold a real ego-browser.
    await symlink(execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim(), join(shim, "ffmpeg"));
    path = `${shim}:${dirname(process.execPath)}`;
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("rejects an unknown adapter name with exit 2", async () => {
    const scenario = await writeTempScenario("name: x\n");
    try {
      const unknown = await cli(["record", scenario.path, "--adapter", "bogus"], work, path);
      assert.equal(unknown.code, 2);
      assert.match(unknown.stderr, /usage: reel-mesh record .*--adapter playwright\|ego-browser/);
    } finally {
      await scenario.cleanup();
    }
  });

  it("records through the fake: pins the size, writes frames, and finishes the space once", async () => {
    const server = await startFixtureServer();
    const scenario = await writeTempScenario(`name: ego-fake
screens:
  - id: page
    url: ${server.url}/
    size: [800, 600]
timing: { stepTimeoutMs: 2000, pointerSteps: 2, pointerStepMs: 20, frameMs: 100 }
steps:
  - caption: "hello"
  - wait: 100
`);
    try {
      const result = await cli(["record", scenario.path, "--adapter", "ego-browser"], work, path);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.ok(existsSync(join(work, ".reel", "ego-fake", "frames.json")));
      assert.match(result.stdout, /Ego Lite 2\.9\.9 is available/);
      const all = await calls();
      const viewport = all.find((c) => c.call === "page.cdp" && c.method === "Emulation.setDeviceMetricsOverride");
      assert.deepEqual(viewport?.params, { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
      // check and record each open their own task space; every space is finished exactly once.
      const finished = all.filter((c) => c.call === "task.finish").map((c) => c.space);
      assert.equal(finished.length, 2);
      assert.equal(new Set(finished).size, 2);
      assert.equal(all.at(-1)?.call, "task.finish");
    } finally {
      await scenario.cleanup();
      await server.stop();
    }
  });
});
