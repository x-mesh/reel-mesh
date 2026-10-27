import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import type { PageId } from "../src/browser/adapter.ts";
import { launchOptions, runPrecheck } from "../src/precheck.ts";
import { recordScenario } from "../src/recorder.ts";
import { loadScenario, ScenarioError } from "../src/scenario.ts";
import { openRunLog } from "../src/runlog.ts";

const PANEL_PAGE = "panel.html";
const examples = fileURLToPath(new URL("../examples", import.meta.url));
const EXT_NAME = "reel-mesh-fixture-ext";
const TIMING = "{ stepTimeoutMs: 2000, pointerSteps: 3, pointerStepMs: 20, frameMs: 100 }";
const OTHER_TAB_TITLE = "SECRET-OTHER-TAB";

interface FrameJson {
  screens: Record<string, string>;
}

const pngSize = (bytes: Buffer): [number, number] => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];

// A panel that follows the active tab instead of the requested one (F4): it is opened on the wrong tab.
class WrongTabAdapter extends PlaywrightAdapter {
  wrongTarget: PageId | undefined;
  override openExtensionPage(extensionId: string, path: string, pinTo: PageId | null): Promise<PageId> {
    return super.openExtensionPage(extensionId, path, pinTo === null ? null : (this.wrongTarget ?? pinTo));
  }
}

describe("extension screens", () => {
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
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-ext-"));
    adapter = new PlaywrightAdapter();
  });
  afterEach(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function scenarioFile(edit: (text: string) => string = (t) => t): Promise<string> {
    await cp(join(examples, "fixture-ext"), join(dir, "fixture-ext"), { recursive: true });
    const text = (await readFile(join(examples, "scenarios", "fixture-ext.yaml"), "utf8"))
      .replace("http://127.0.0.1:5173", server.url)
      .replace("../fixture-ext", "./fixture-ext")
      .replace(/timing: .*/, `timing: ${TIMING}`);
    const path = join(dir, "fixture-ext.yaml");
    await writeFile(path, edit(text));
    return path;
  }

  async function launch(path: string): Promise<void> {
    await adapter.launch(launchOptions(loadScenario(path)));
  }

  async function onPanel<T>(work: (page: PageId) => Promise<T>): Promise<T> {
    const id = await adapter.findExtensionId(EXT_NAME);
    assert.ok(id);
    const page = await adapter.openExtensionPage(id, PANEL_PAGE, null);
    try {
      return await work(page);
    } finally {
      await adapter.closePage(page);
    }
  }

  const storedDock = () => onPanel((page) => adapter.evaluate<unknown>(page, `chrome.storage.local.get("dockHeight").then((v) => v.dockHeight ?? null)`));

  async function record(path: string, target: PlaywrightAdapter = adapter) {
    const scenario = loadScenario(path);
    const lines: string[] = [];
    const result = await recordScenario(scenario, target, openRunLog(scenario.name, dir), (line) => lines.push(line));
    return { result, lines, outDir: join(dir, ".reel", scenario.name) };
  }

  it("finds the extension by manifest name and returns null for an unknown name", async () => {
    await launch(await scenarioFile());
    assert.match((await adapter.findExtensionId(EXT_NAME)) ?? "", /^[a-p]{32}$/);
    assert.equal(await adapter.findExtensionId("no-such-extension"), null);
  });

  it("records both screens at their sizes with the panel pinned to the page tab", async () => {
    const path = await scenarioFile();
    await launch(path);
    const other = await adapter.openPage();
    await adapter.goto(other, `${server.url}/blank.html`);
    await adapter.evaluate(other, `document.title = ${JSON.stringify(OTHER_TAB_TITLE)}`);

    const { result, outDir } = await record(path);
    assert.equal(result.code, 0);
    const frames = JSON.parse(await readFile(join(outDir, "frames.json"), "utf8")) as FrameJson[];
    assert.ok(frames.length > 0);
    for (const frame of frames) {
      assert.deepEqual(Object.keys(frame.screens).sort(), ["page", "panel"]);
      assert.deepEqual(pngSize(await readFile(join(outDir, frame.screens.page))), [1040, 760]);
      assert.deepEqual(pngSize(await readFile(join(outDir, frame.screens.panel))), [360, 760]);
    }

    const page = result.pages.get("page")!;
    const panel = result.pages.get("panel")!;
    const id = (await adapter.findExtensionId(EXT_NAME))!;
    const pageTab = await adapter.tabIdOf(id, PANEL_PAGE, page);
    assert.equal(await adapter.evaluate(panel, "window.__reelPinnedTabId"), pageTab);
    const text = await adapter.evaluate<string>(panel, "document.body.innerText");
    assert.match(text, /fixture-app/);
    assert.equal(text.includes(OTHER_TAB_TITLE), false, "the panel must not show another tab's title (RM-12)");
    assert.equal(await storedDock(), null, "chrome.storage returns to its pre-record state");
  });

  it("rejects a pinTo that is not a URL screen before recording", async () => {
    const path = await scenarioFile((t) => t.replace("pinTo: page", "pinTo: panel"));
    assert.throws(() => loadScenario(path), (e: unknown) => e instanceof ScenarioError && e.errors.some((line) => line.includes("extension.pinTo")));
  });

  it("exits 3 without recording when the panel binds to another tab (F4)", async () => {
    const path = await scenarioFile();
    const wrong = new WrongTabAdapter();
    try {
      await wrong.launch(launchOptions(loadScenario(path)));
      wrong.wrongTarget = await wrong.openPage();
      await wrong.goto(wrong.wrongTarget, `${server.url}/blank.html`);
      const { result, lines, outDir } = await record(path, wrong);
      assert.equal(result.code, 3);
      assert.ok(lines.some((line) => line.includes("패널이 대상 탭에 붙지 않았습니다")));
      assert.equal(existsSync(join(outDir, "frames.json")), false);
    } finally {
      await wrong.close();
    }
  });

  it("restores chrome.storage after a failed record that changed dockHeight", async () => {
    const path = await scenarioFile((t) => t.replace("  - wait: 400", `  - expect: { screen: panel, selector: "#missing" }`));
    await launch(path);
    await onPanel((page) => adapter.evaluate(page, `chrome.storage.local.set({ dockHeight: 500, "other:key": "kept" })`));
    const { result, outDir } = await record(path);
    assert.equal(result.code, 1);
    const report = JSON.parse(await readFile(join(outDir, "state-restore.json"), "utf8")) as { equal: boolean };
    assert.equal(report.equal, true);
    assert.equal(await storedDock(), 500);
    assert.equal(await onPanel((page) => adapter.evaluate(page, `chrome.storage.local.get("other:key").then((v) => v["other:key"])`)), "kept");
    assert.equal(existsSync(join(outDir, "state-snapshot.json")), false);
  });

  it("check reports the extension id and the pin, and tells what to do when the name is wrong", async () => {
    const good = loadScenario(await scenarioFile());
    const lines: string[] = [];
    assert.equal(await runPrecheck(good, openRunLog(good.name, dir), () => new PlaywrightAdapter(), (line) => lines.push(line)), 0);
    assert.ok(lines.some((line) => /^ok 확장: reel-mesh-fixture-ext \(id [a-p]{32}\)/.test(line)));
    assert.ok(lines.some((line) => line.startsWith("ok 대상 탭 고정")));

    const bad = loadScenario(await scenarioFile((t) => t.replace(`name: ${EXT_NAME}`, "name: wrong-name")));
    const badLines: string[] = [];
    assert.equal(await runPrecheck(bad, openRunLog(bad.name, dir), () => new PlaywrightAdapter(), (line) => badLines.push(line)), 3);
    const failure = badLines.find((line) => line.startsWith("FAIL 확장"));
    assert.ok(failure);
    assert.match(failure, /할 일: extension\.name/);
  });
});
