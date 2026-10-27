import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import { recordScenario } from "../src/recorder.ts";
import { loadScenario } from "../src/scenario.ts";
import { openRunLog } from "../src/runlog.ts";
import { runRestore } from "../src/state.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const examples = fileURLToPath(new URL("../examples/scenarios", import.meta.url));
const TIMING = "{ stepTimeoutMs: 2000, pointerSteps: 3, pointerStepMs: 20, frameMs: 100 }";
const LOG_KEY = "fixture:log:a";
const DOCK_KEY = "fixture:dockHeight";

type Stored = Record<string, string>;

describe("state isolation and restore", () => {
  let server: FixtureServer;
  let adapter: PlaywrightAdapter;
  let dir: string;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server.stop();
  });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-state-"));
    adapter = new PlaywrightAdapter();
    await adapter.launch();
  });
  afterEach(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function onBlank<T>(work: (page: string) => Promise<T>): Promise<T> {
    const page = await adapter.openPage();
    try {
      await adapter.goto(page, `${server.url}/blank.html`);
      return await work(page);
    } finally {
      await adapter.closePage(page);
    }
  }
  const seed = (values: Stored) =>
    onBlank((page) => adapter.evaluate(page, `(() => { for (const [k, v] of Object.entries(${JSON.stringify(values)})) localStorage.setItem(k, v); })()`));
  const stored = () =>
    onBlank((page) => adapter.evaluate<Stored>(page, `(() => Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)])))()`));

  // Writes the fail scenario next to a copy of its scripts, pointed at the fixture server.
  async function failScenario(edit: (text: string) => string = (t) => t): Promise<string> {
    await cp(join(examples, "scripts"), join(dir, "scripts"), { recursive: true });
    const text = (await readFile(join(examples, "fixture-app-fail.yaml"), "utf8")).replace("http://127.0.0.1:5173", server.url);
    const path = join(dir, "fail.yaml");
    await writeFile(path, edit(text));
    return path;
  }

  async function record(path: string) {
    const scenario = loadScenario(path);
    const lines: string[] = [];
    const result = await recordScenario(scenario, adapter, openRunLog(scenario.name, dir), (line) => lines.push(line));
    const outDir = join(dir, ".reel", scenario.name);
    return { result, lines, outDir, report: () => readFile(join(outDir, "state-restore.json"), "utf8").then((t) => JSON.parse(t) as { equal: boolean; diffs: unknown[] }) };
  }

  it("restores the pre-record values after a failed record (DONE-3)", async () => {
    const original = { [DOCK_KEY]: "500", [LOG_KEY]: '["old"]', "other:key": "kept" };
    await seed(original);
    const { result, outDir, report } = await record(await failScenario());
    assert.equal(result.code, 1);
    const r = await report();
    assert.equal(r.equal, true);
    assert.deepEqual(r.diffs, []);
    assert.deepEqual(await stored(), original);
    assert.equal(existsSync(join(outDir, "state-snapshot.json")), false);
  });

  it("does not keep a value left by a failed record as the next original (F7)", async () => {
    const path = await failScenario();
    const first = await record(path);
    assert.equal(first.result.code, 1);
    assert.deepEqual(await stored(), {}, "no stored value existed before the record; the app's 365 and 210 must not remain");
    const second = await record(path);
    assert.equal(second.result.code, 1);
    assert.equal((await second.report()).equal, true);
    assert.deepEqual(await stored(), {});
  });

  it("starts every record without the previous log", async () => {
    const original = { [LOG_KEY]: '["old"]' };
    await seed(original);
    const path = await failScenario((t) => t.replace(/  - script: scripts\/throw.js\n/, ""));
    for (let i = 0; i < 2; i++) {
      const { result } = await record(path);
      assert.equal(result.code, 0, `record ${i + 1}`);
    }
    assert.deepEqual(await stored(), original);
  });

  it("restores through the blank origin but reports a difference when it is off (F8)", async () => {
    const original = { [LOG_KEY]: '["old"]' };
    await seed(original);
    const off = await record(await failScenario((t) => t.replace("restoreViaBlankOrigin: true", "restoreViaBlankOrigin: false")));
    assert.equal(off.result.code, 4);
    const r = await off.report();
    assert.equal(r.equal, false);
    assert.ok(r.diffs.length > 0);
    assert.equal(existsSync(join(off.outDir, "state-snapshot.json")), true);

    await rm(join(off.outDir, "state-snapshot.json"));
    await adapter.close();
    adapter = new PlaywrightAdapter();
    await adapter.launch();
    await seed(original);
    const on = await record(await failScenario());
    assert.equal(on.result.code, 1);
    assert.equal((await on.report()).equal, true);
    assert.deepEqual(await stored(), original);
  });

  it("refuses to record while a snapshot is left (exit 5)", async () => {
    const path = await failScenario();
    const scenario = loadScenario(path);
    const log = openRunLog(scenario.name, dir);
    await writeFile(join(dir, ".reel", scenario.name, "state-snapshot.json"), JSON.stringify({ origins: {} }));
    const lines: string[] = [];
    const result = await recordScenario(scenario, adapter, log, (line) => lines.push(line));
    assert.equal(result.code, 5);
    assert.ok(lines.some((line) => /node \/\S+\/bin\/reel-mesh\.ts restore \S+ --adapter playwright/.test(line)));
    assert.equal(existsSync(join(dir, ".reel", scenario.name, "frames")), false);
  });

  it("applies a left snapshot with the restore command", async () => {
    const path = await failScenario();
    const scenario = loadScenario(path);
    openRunLog(scenario.name, dir);
    const outDir = join(dir, ".reel", scenario.name);
    await writeFile(
      join(outDir, "state-snapshot.json"),
      JSON.stringify({ adapter: "playwright", origins: { [new URL(server.url).origin]: { [DOCK_KEY]: "500" } } }),
    );
    const code = await new Promise<number>((resolve) => {
      execFile(process.execPath, [bin, "restore", path], { cwd: dir, timeout: 90000 }, (error) => resolve(error ? ((error as { code?: number }).code ?? -1) : 0));
    });
    assert.equal(code, 0);
    assert.equal(JSON.parse(await readFile(join(outDir, "state-restore.json"), "utf8")).equal, true);
    assert.equal(existsSync(join(outDir, "state-snapshot.json")), false);
  });

  it("keeps typed text in the prompt input (type success path)", async () => {
    const path = join(dir, "type.yaml");
    await writeFile(
      path,
      `name: type-ok
screens:
  - id: page
    url: ${server.url}/
    size: [800, 600]
timing: ${TIMING}
steps:
  - click: { screen: page, target: "[name=prompt]" }
  - type: { screen: page, target: "[name=prompt]", text: "hello" }
`,
    );
    const scenario = loadScenario(path);
    const result = await recordScenario(scenario, adapter, openRunLog(scenario.name, dir), () => undefined);
    assert.equal(result.code, 0);
    const value = await adapter.evaluate(result.pages.get("page")!, `document.querySelector("[name=prompt]").value`);
    assert.equal(value, "hello");
  });

  it("removes the temporary profile after a failed record", async () => {
    const profile = adapter.profileDir!;
    const { result } = await record(await failScenario());
    assert.equal(result.code, 1);
    await adapter.close();
    assert.equal(existsSync(profile), false);
  });
});

describe("restore adapter guard", () => {
  it("refuses to restore through a different adapter and keeps the snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reel-restore-guard-"));
    try {
      const scenario = loadScenario(join(examples, "fixture-app.yaml"));
      const log = openRunLog(scenario.name, dir);
      const snapshot = join(dir, ".reel", scenario.name, "state-snapshot.json");
      await writeFile(snapshot, JSON.stringify({ adapter: "ego-browser", origins: {}, chromeStorage: {} }));
      let launched = false;
      const lines: string[] = [];
      const code = await runRestore(scenario, log, () => {
        const adapter = new PlaywrightAdapter();
        adapter.launch = async () => {
          launched = true;
        };
        return adapter;
      }, (line) => lines.push(line));
      assert.equal(code, 2);
      assert.equal(launched, false);
      assert.ok(existsSync(snapshot));
      assert.ok(lines.some((line) => line.includes("--adapter ego-browser")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
