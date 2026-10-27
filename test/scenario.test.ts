import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, parseScenario, ScenarioError } from "../src/scenario.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "examples/scenarios/fixture-app.yaml");
const base = "name: t\nscreens:\n  - { id: page, url: 'http://x/', size: [100, 100] }\n";

function errorsOf(yaml: string): string[] {
  try {
    parseScenario(yaml, join(tmpdir(), "t.yaml"));
  } catch (e) {
    if (e instanceof ScenarioError) return e.errors;
    throw e;
  }
  return [];
}

test("fixture scenario loads", () => {
  const s = loadScenario(fixture);
  assert.equal(s.name, "fixture-app");
  assert.equal(s.steps.length, 6);
  assert.equal(s.steps[1].action.kind, "click");
  assert.deepEqual(s.steps[1].expect, { screen: "page", selector: "h1" });
  assert.equal(s.steps[1].retry, 2);
});

test("expect alone is a check step; next to an action it is that action's expected state", () => {
  const s = parseScenario(`${base}steps:\n  - expect: { screen: page, selector: h1 }\n    retry: 1\n  - dblclick: { screen: page, target: h1 }\n    expect: { screen: page, selector: "[data-selected=h1]" }\n    retry: 3\n`, "t.yaml");
  assert.equal(s.steps[0].action.kind, "expect");
  assert.equal(s.steps[0].expect, null);
  assert.equal(s.steps[1].action.kind, "dblclick");
  assert.deepEqual(s.steps[1].expect, { screen: "page", selector: "[data-selected=h1]" });
  assert.equal(s.steps[1].retry, 3);
});

test("rejects retry on an action without expect", () => {
  assert.deepEqual(errorsOf(`${base}steps:\n  - click: { screen: page, target: h1 }\n    retry: 2\n`), ["steps[0].retry: requires expect on the same step"]);
});

test("defaults are filled with no undefined", () => {
  const s = parseScenario(`${base}steps:\n  - wait: 10\n`, "t.yaml");
  assert.deepEqual(s.caption.position, { page: "bottom" });
  assert.equal(s.timing.stepTimeoutMs, 30000);
  assert.equal(s.timing.pointerSteps, 12);
  assert.equal(s.timing.pointerStepMs, 33);
  assert.equal(s.timing.contactSheetIntervalMs, 2400);
  assert.equal(s.screens[0].scale, 1);
  assert.equal(s.steps[0].retry, 0);
  assert.equal(s.layout.direction, "horizontal");
  assert.equal(s.layout.border, 2);
  assert.deepEqual(s.mask, []);
  assert.equal(s.state.blankPath, null);
  assert.ok(!JSON.stringify(s, (_, v) => (v === undefined ? "UNDEF" : v)).includes("UNDEF"));
});

test("target forms parse", () => {
  const s = parseScenario(
    `${base}steps:
  - click: { screen: page, target: { frame: "iframe", target: { shadow: [x-host, button] } } }
  - click: { screen: page, target: { text: Go } }
`,
    "t.yaml",
  );
  const a = s.steps[0].action;
  assert.ok(a.kind === "click" && a.target.kind === "frame" && a.target.target.kind === "shadow");
});

test("rejects unknown key with path", () => {
  assert.deepEqual(errorsOf(`${base}bogus: 1\nsteps:\n  - wait: 1\n`), ["scenario.bogus: unknown key"]);
});

test("rejects duplicate screen id", () => {
  const y = `name: t\nscreens:\n  - { id: a, url: 'http://x/', size: [1, 1] }\n  - { id: a, url: 'http://y/', size: [1, 1] }\nsteps:\n  - wait: 1\n`;
  assert.deepEqual(errorsOf(y), ['screens[1].id: duplicate screen id "a"']);
});

test("rejects unknown screen reference", () => {
  assert.deepEqual(errorsOf(`${base}steps:\n  - press: { screen: nope, key: Enter }\n`), ['steps[0].press.screen: unknown screen "nope"']);
});

test("rejects zero or multiple action keys", () => {
  assert.equal(errorsOf(`${base}steps:\n  - retry: 1\n`).length, 1);
  const multi = errorsOf(`${base}steps:\n  - { wait: 1, caption: hi }\n`);
  assert.equal(multi.length, 1);
  assert.match(multi[0], /^steps\[0\]: exactly one action key allowed/);
});

test("reports missing click target by path", () => {
  assert.deepEqual(errorsOf(`${base}steps:\n  - wait: 1\n  - wait: 1\n  - wait: 1\n  - click: { screen: page }\n`), ["steps[3].click.target: required"]);
});

test("rejects restoreViaBlankOrigin without blankPath", () => {
  assert.deepEqual(errorsOf(`${base}state: { restoreViaBlankOrigin: true }\nsteps:\n  - wait: 1\n`), [
    "state.blankPath: required when restoreViaBlankOrigin is true",
  ]);
});

test("rejects missing script file relative to the scenario", () => {
  const dir = mkdtempSync(join(tmpdir(), "reel-mesh-scn-"));
  try {
    const file = join(dir, "s.yaml");
    writeFileSync(file, `${base}steps:\n  - script: ./a.js\n`);
    assert.throws(() => loadScenario(file), /steps\[0\]\.script: script file not found/);
    writeFileSync(join(dir, "a.js"), "");
    assert.equal(loadScenario(file).steps[0].action.kind, "script");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate command: exit codes and no .reel directory", () => {
  const ok = spawnSync("node", ["bin/reel-mesh.ts", "validate", fixture], { cwd: root, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^ok: fixture-app/);
  const dir = mkdtempSync(join(tmpdir(), "reel-mesh-scn-"));
  try {
    const bad = join(dir, "bad.yaml");
    writeFileSync(bad, `${base}steps:\n  - click: { screen: page }\n`);
    const r = spawnSync("node", [join(root, "bin/reel-mesh.ts"), "validate", bad], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), "steps[0].click.target: required");
    assert.equal(existsSync(join(dir, ".reel")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension page defaults to panel.html and can be set", () => {
  const y = (ext: string) => `name: t\nscreens:\n  - { id: page, url: 'http://x/', size: [1, 1] }\n  - { id: side, extension: ${ext}, size: [1, 1] }\nsteps:\n  - wait: 1\n`;
  assert.equal(parseScenario(y("{ name: e, path: ./e, pinTo: page }"), "t.yaml").screens[1].extension?.page, "panel.html");
  assert.equal(parseScenario(y("{ name: e, path: ./e, page: sidepanel.html }"), "t.yaml").screens[1].extension?.page, "sidepanel.html");
  assert.deepEqual(errorsOf(y("{ name: e, path: ./e, pinTo: side }")), ['screens[1].extension.pinTo: "side" is not a screen with url']);
});
