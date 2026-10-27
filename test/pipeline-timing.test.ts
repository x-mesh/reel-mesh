import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, writeTempScenario } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const PIPELINE_LIMIT_MS = 180_000;

function reel(command: string, scenario: string, cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, command, scenario], { cwd, timeout: PIPELINE_LIMIT_MS }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, output: stdout + stderr });
    });
  });
}

describe("check, record and render pipeline (DONE-2)", () => {
  let server: FixtureServer;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server?.stop();
  });

  it("finishes the fixture-app scenario in under 180 seconds", async () => {
    const scenario = await writeTempScenario(`name: pipeline
caption:
  lang: en
  position: { page: bottom }
screens:
  - id: page
    url: ${server.url}
    size: [800, 600]
layout: { direction: horizontal, border: 2 }
timing: { stepTimeoutMs: 10000, pointerSteps: 8, pointerStepMs: 30, frameMs: 100 }
steps:
  - caption: "Open the fixture app"
  - click: { screen: page, target: "h1" }
    expect: { screen: page, selector: "h1" }
    retry: 2
  - dblclick: { screen: page, target: "#main-button" }
  - click: { screen: page, target: { shadow: ["#shadow-host", "#shadow-button"] } }
  - wait: 500
`);
    const cwd = await mkdtemp(join(tmpdir(), "reel-mesh-pipeline-"));
    try {
      const started = Date.now();
      for (const command of ["check", "record", "render"]) {
        const r = await reel(command, scenario.path, cwd);
        assert.equal(r.code, 0, `${command}: ${r.output}`);
      }
      const elapsed = Date.now() - started;
      assert.ok(existsSync(join(cwd, ".reel", "pipeline", "pipeline.gif")));
      assert.ok(elapsed < PIPELINE_LIMIT_MS, `pipeline took ${elapsed}ms`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await scenario.cleanup();
    }
  });
});
