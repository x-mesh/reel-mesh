import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import { recordScenario } from "../src/recorder.ts";
import type { RecordResult } from "../src/recorder.ts";
import { loadScenario } from "../src/scenario.ts";
import { openRunLog } from "../src/runlog.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const TIMING = "{ stepTimeoutMs: 2000, pointerSteps: 4, pointerStepMs: 20, frameMs: 100 }";

interface Cli {
  code: number;
  stdout: string;
}

function cli(args: string[], cwd: string): Promise<Cli> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, timeout: 90000 }, (error, stdout) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stdout });
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const scenarioText = (name: string, url: string, steps: string, timing = TIMING) => `name: ${name}
screens:
  - id: page
    url: ${url}
    size: [800, 600]
timing: ${timing}
steps:
${steps}
`;

const script = (body: string, arg = "undefined") => `export default async function (ctx) {
  await ctx.evaluate("page", ${body}, ${arg});
}
`;

const INSTALL_PROBES = script(`() => {
  window.__bodyOverlayRecords = 0;
  new MutationObserver((records) => {
    for (const r of records) {
      const nodes = [r.target, ...r.addedNodes, ...r.removedNodes];
      if (nodes.some((n) => n.nodeType === 1 && (n.hasAttribute("data-reel-overlay") || n.querySelector("[data-reel-overlay]")))) window.__bodyOverlayRecords++;
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true });
  window.__shadowClicks = 0;
  window.__frameClicks = 0;
  document.getElementById("shadow-host").shadowRoot.getElementById("shadow-button").addEventListener("click", () => window.__shadowClicks++);
  const frameDoc = document.getElementById("frame").contentDocument;
  frameDoc.getElementById("frame-button").addEventListener("click", () => window.__frameClicks++);
}`);

const PROBE_OVERLAY = script(`() => {
  window.__overlayDuringRun = document.documentElement.querySelector(":scope > [data-reel-overlay]") !== null;
  window.__overlayInBody = document.body.querySelector("[data-reel-overlay]") !== null;
}`);

const readyAfter = (clicks: number) =>
  script(
    `(need) => {
  let n = 0;
  document.getElementById("main-button").addEventListener("click", () => {
    n++;
    if (n >= need) {
      const el = document.createElement("div");
      el.id = "ready";
      document.body.append(el);
    }
  });
}`,
    String(clicks),
  );

describe("record", () => {
  let server: FixtureServer;
  let dir: string;
  let runs = 0;

  before(async () => {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-record-"));
  });
  after(async () => {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function scenarioFile(text: string, scripts: Record<string, string> = {}): Promise<string> {
    const sub = join(dir, `s${runs++}`);
    await mkdir(sub, { recursive: true });
    for (const [name, body] of Object.entries(scripts)) await writeFile(join(sub, name), body);
    const path = join(sub, "scenario.yaml");
    await writeFile(path, text);
    return path;
  }

  async function inProcess<T>(file: string, inspect: (result: RecordResult, adapter: PlaywrightAdapter, out: string[]) => Promise<T>): Promise<T> {
    const scenario = loadScenario(file);
    const adapter = new PlaywrightAdapter();
    await adapter.launch();
    try {
      const out: string[] = [];
      const log = openRunLog(scenario.name, join(dir, `out${runs++}`));
      const result = await recordScenario(scenario, adapter, log, (line) => out.push(line));
      return await inspect(result, adapter, out);
    } finally {
      await adapter.close();
    }
  }

  it("records a single screen, hits shadow/iframe/scrolled targets, and leaves no overlay in body or after the run", async () => {
    const file = await scenarioFile(
      scenarioText(
        "single",
        server.url,
        `  - script: install.js
  - caption: "Hello"
  - dblclick: { screen: page, target: "#main-button" }
  - click: { screen: page, target: { shadow: ["#shadow-host", "#shadow-button"] } }
  - click: { screen: page, target: { frame: "#frame", target: "#frame-button" } }
  - script: probe.js
  - click: { screen: page, target: { text: "item 20" } }
  - wait: 300`,
      ),
      { "install.js": INSTALL_PROBES, "probe.js": PROBE_OVERLAY },
    );
    await inProcess(file, async (result, adapter, out) => {
      assert.equal(result.code, 0, out.join("\n"));
      assert.ok(result.framesPath && existsSync(result.framesPath));
      const frames = JSON.parse(await readFile(result.framesPath, "utf8")) as RecordResult["frames"];
      assert.deepEqual(frames, result.frames);
      // 1 (script) + 1 (caption) + 5 (dblclick) + 5 + 5 + 1 (probe script) + 5 = 23
      assert.equal(frames.length, 23);
      assert.deepEqual(frames.map((f) => f.index), frames.map((_, i) => i));
      for (const f of frames) assert.ok(existsSync(join(dirname(result.framesPath!), f.screens.page!)));
      assert.equal(frames.at(-1)!.durationMs, 100 + 300);
      assert.equal(frames[2]!.durationMs, 20);

      const page = result.pages.get("page")!;
      assert.deepEqual(await adapter.evaluate(page, "window.__clickDetails"), [1, 2, 1, 1]);
      assert.equal(await adapter.evaluate(page, "window.__shadowClicks"), 1);
      assert.equal(await adapter.evaluate(page, "window.__frameClicks"), 1);
      assert.equal(await adapter.evaluate(page, "document.getElementById('scroller').scrollTop > 0"), true);
      assert.equal(await adapter.evaluate(page, "window.__overlayDuringRun"), true);
      assert.equal(await adapter.evaluate(page, "window.__overlayInBody"), false);
      assert.equal(await adapter.evaluate(page, "window.__bodyOverlayRecords"), 0);
      assert.equal(await adapter.evaluate(page, "document.querySelectorAll('[data-reel-overlay]').length"), 0);
    });
  });

  it("keeps the frame count when an expectation holds only on the second attempt", async () => {
    const flow = (name: string, retry: number) =>
      scenarioText(
        name,
        server.url,
        `  - script: ready.js
  - click: { screen: page, target: "#main-button" }
    expect: { screen: page, selector: "#ready" }${retry > 0 ? `\n    retry: ${retry}` : ""}`,
      );
    const baseline = await scenarioFile(flow("baseline", 0), { "ready.js": readyAfter(1) });
    const retried = await scenarioFile(flow("retried", 1), { "ready.js": readyAfter(2) });
    const base = await inProcess(baseline, async (r, _a, out) => (assert.equal(r.code, 0, out.join("\n")), r));
    await inProcess(retried, async (r, _a, out) => {
      assert.equal(r.code, 0, out.join("\n"));
      assert.equal(r.frames.length, base.frames.length);
      assert.deepEqual(r.frames.map((f) => f.durationMs), base.frames.map((f) => f.durationMs));
      assert.deepEqual(r.frames.map((f) => f.step), base.frames.map((f) => f.step));
    });
    const log = await readFile(join(dir, `out${runs - 1}`, ".reel", "retried", "run.log"), "utf8").catch(() => "");
    assert.match(log, /retry 1\/1/);
  });

  it("fails after exhausting retries when the expectation never holds", async () => {
    const file = await scenarioFile(
      scenarioText(
        "never",
        server.url,
        `  - click: { screen: page, target: "#main-button" }
    expect: { screen: page, selector: "#never" }
    retry: 1`,
      ),
    );
    await inProcess(file, async (r, _a, out) => {
      assert.equal(r.code, 1);
      assert.equal(r.frames.length, 0);
      assert.match(out.join("\n"), /^FAIL step 1 click: .*#never/m);
    });
  });

  it("fails a type step whose target cannot take focus", async () => {
    const file = await scenarioFile(scenarioText("nofocus", server.url, `  - type: { screen: page, target: h1, text: "x" }`));
    await inProcess(file, async (r, _a, out) => {
      assert.equal(r.code, 1);
      assert.match(out.join("\n"), /^FAIL step 1 type: .*포커스/m);
    });
  });

  it("rejects a target that matches two elements instead of picking the first", async () => {
    const file = await scenarioFile(scenarioText("ambiguous", server.url, `  - click: { screen: page, target: "#scroller li" }`));
    await inProcess(file, async (r, _a, out) => {
      assert.equal(r.code, 1);
      assert.match(out.join("\n"), /^FAIL step 1 click: .*20개 일치/m);
    });
  });

  it("exits 1 within 10 seconds with the failing step and last frame when a later target never appears", async () => {
    const file = await scenarioFile(
      scenarioText(
        "late",
        server.url,
        `  - click: { screen: page, target: "#title" }
  - click: { screen: page, target: "#appears-never" }`,
      ),
    );
    const cwd = await mkdtemp(join(tmpdir(), "reel-mesh-cwd-"));
    try {
      const started = Date.now();
      const r = await cli(["record", file], cwd);
      assert.equal(r.code, 1, r.stdout);
      assert.ok(Date.now() - started < 10000, `took ${Date.now() - started}ms`);
      assert.match(r.stdout, /^FAIL step 2 click: .*#appears-never/m);
      const last = /^last frame: (.+\.png)$/m.exec(r.stdout)?.[1];
      assert.ok(last && existsSync(last), r.stdout);
      const logPath = /^log: (.+run\.log)$/m.exec(r.stdout)?.[1];
      assert.ok(logPath && existsSync(logPath));
      assert.match(await readFile(logPath, "utf8"), /step 2 click\tfail /);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("exits 3 without recording when the precheck fails", async () => {
    const port = await freePort();
    const file = await scenarioFile(scenarioText("prefail", `http://127.0.0.1:${port}/`, `  - click: { screen: page, target: h1 }`));
    const cwd = await mkdtemp(join(tmpdir(), "reel-mesh-cwd-"));
    try {
      const r = await cli(["record", file], cwd);
      assert.equal(r.code, 3, r.stdout);
      assert.equal(existsSync(join(cwd, ".reel", "prefail", "frames")), false);
      assert.equal(existsSync(join(cwd, ".reel", "prefail", "frames.json")), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
