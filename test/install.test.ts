import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, writeTempScenario } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts", "install.sh");
// The temporary HOME has no npm cache or Playwright browsers, so both point at this machine's real ones.
const npmCache = join(homedir(), ".npm");
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");

describe("scripts/install.sh", () => {
  let base: string;
  let home: string;
  let runtime: string;
  let binDir: string;
  let server: FixtureServer;

  const env = () => ({
    ...process.env,
    HOME: home,
    XDG_STATE_HOME: "",
    REEL_MESH_HOME: runtime,
    REEL_MESH_BIN_DIR: binDir,
    npm_config_cache: npmCache,
    npm_config_prefer_offline: "true",
    PLAYWRIGHT_BROWSERS_PATH: browsers,
  });
  const sh = (args: string[]) => {
    const r = spawnSync("bash", [script, ...args], { encoding: "utf8", env: env(), timeout: 300000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const cli = (args: string[]) => {
    const r = spawnSync(join(binDir, "reel-mesh"), args, { encoding: "utf8", env: env(), timeout: 120000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };

  before(async () => {
    base = mkdtempSync(join(tmpdir(), "reel-install-"));
    home = join(base, "home");
    runtime = join(base, "home", ".local", "share", "reel-mesh");
    binDir = join(base, "home", ".local", "bin");
    mkdirSync(join(home, ".cursor"), { recursive: true });
    server = await startFixtureServer();
  });
  after(async () => {
    await server.stop();
    rmSync(base, { recursive: true, force: true });
  });

  it("installs the runtime, the CLI and the cursor skill from a local checkout", () => {
    const r = sh(["install", "--source", root, "--skip-browser", "--targets", "cursor", "--yes"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /CLI installed: /);
    assert.match(r.out, /ok cursor: /);
    assert.ok(existsSync(join(runtime, "node_modules", "playwright")));
    assert.equal(existsSync(join(runtime, "node_modules", "typescript")), false, "dev dependencies are not installed");
    for (const hidden of [".git", ".xm", "docs/REQUIREMENTS.md", ".reel"]) assert.equal(existsSync(join(runtime, hidden)), false, hidden);
    assert.ok(existsSync(join(home, ".cursor", "skills", "reel-mesh", "SKILL.md")));
  });

  it("the installed CLI runs the precheck against a live page", async () => {
    const yaml = `name: installed-check\nscreens:\n  - id: page\n    url: ${server.url}/\n    size: [800, 600]\nsteps:\n  - click: { screen: page, target: "h1" }\n`;
    const scenario = await writeTempScenario(yaml);
    try {
      const r = cli(["check", scenario.path]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /check: 모두 통과/);
    } finally {
      await scenario.cleanup();
    }
  });

  it("status reports the CLI and the registered target", () => {
    const r = sh(["status"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /cursor: installed/);
  });

  it("uninstall removes the skill, the CLI and the runtime", () => {
    const r = sh(["uninstall"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(existsSync(join(home, ".cursor", "skills", "reel-mesh")), false);
    assert.equal(existsSync(join(binDir, "reel-mesh")), false);
    assert.equal(existsSync(runtime), false);
    assert.ok(existsSync(join(home, ".cursor")), "the tool's own folder stays");
  });

  it("refuses to replace a runtime folder it did not create", () => {
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, "mine.txt"), "x");
    const r = sh(["install", "--source", root, "--skip-browser", "--targets", "cursor", "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /was not installed by reel-mesh/);
    assert.ok(existsSync(join(runtime, "mine.txt")));
  });
});
