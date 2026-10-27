import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, writeTempScenario } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import type { FrameRecord } from "../src/recorder.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));

function record(scenario: string, cwd: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, "record", scenario], { cwd, timeout: 90000 }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? -1) : 0);
    });
  });
}

describe("determinism (DONE-6)", () => {
  let server: FixtureServer;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server?.stop();
  });

  it("records the same frame count and total duration on two runs", async () => {
    const scenario = await writeTempScenario(`name: determinism
screens:
  - id: page
    url: ${server.url}
    size: [800, 600]
timing: { stepTimeoutMs: 5000, pointerSteps: 5, pointerStepMs: 25, frameMs: 80 }
steps:
  - caption: "Determinism"
  - dblclick: { screen: page, target: "#main-button" }
  - click: { screen: page, target: { shadow: ["#shadow-host", "#shadow-button"] } }
  - click: { screen: page, target: { frame: "#frame", target: "#frame-button" } }
  - wait: 200
`);
    const cwds = [await mkdtemp(join(tmpdir(), "reel-mesh-det-")), await mkdtemp(join(tmpdir(), "reel-mesh-det-"))];
    try {
      const runs: FrameRecord[][] = [];
      for (const cwd of cwds) {
        assert.equal(await record(scenario.path, cwd), 0);
        runs.push(JSON.parse(await readFile(join(cwd, ".reel", "determinism", "frames.json"), "utf8")) as FrameRecord[]);
      }
      const total = (frames: FrameRecord[]) => frames.reduce((sum, f) => sum + f.durationMs, 0);
      assert.ok(runs[0]!.length > 0);
      assert.equal(runs[0]!.length, runs[1]!.length);
      assert.equal(total(runs[0]!), total(runs[1]!));
      assert.deepEqual(runs[0]!.map((f) => f.durationMs), runs[1]!.map((f) => f.durationMs));
    } finally {
      await Promise.all(cwds.map((cwd) => rm(cwd, { recursive: true, force: true })));
      await scenario.cleanup();
    }
  });
});
