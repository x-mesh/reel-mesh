import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = join(root, "bin", "reel-mesh.ts");

// Stateful stand-ins for the claude and codex CLIs: they record every call and remember what was installed.
const FAKE_CLAUDE = `#!/usr/bin/env bash
echo "claude $*" >> "$FAKE_LOG"
case "$*" in
  "plugin marketplace list --json") if [ -f "$FAKE_STATE/claude-market" ]; then echo '[{"name":"reel-mesh"}]'; else echo '[]'; fi ;;
  "plugin list --json") if [ -f "$FAKE_STATE/claude-plugin" ]; then echo '[{"id":"reel-mesh@reel-mesh"}]'; else echo '[]'; fi ;;
  "plugin marketplace add "*) touch "$FAKE_STATE/claude-market" ;;
  "plugin marketplace remove "*) rm -f "$FAKE_STATE/claude-market" ;;
  "plugin install "* | "plugin update "*) touch "$FAKE_STATE/claude-plugin" ;;
  "plugin uninstall "*) rm -f "$FAKE_STATE/claude-plugin" ;;
esac
`;
const FAKE_CODEX = `#!/usr/bin/env bash
echo "codex $*" >> "$FAKE_LOG"
if [ -n "\${FAKE_CODEX_FAIL:-}" ] && [ "$2" = add ]; then echo "rejected" >&2; exit 1; fi
`;

interface Env {
  home: string;
  fakes: string;
  log: string;
}

function makeEnv(): Env {
  const base = mkdtempSync(join(tmpdir(), "reel-setup-"));
  const home = join(base, "home");
  const fakes = join(base, "fakes");
  mkdirSync(join(fakes, "state"), { recursive: true });
  for (const [name, body] of [["claude", FAKE_CLAUDE], ["codex", FAKE_CODEX]] as const) {
    writeFileSync(join(fakes, name), body);
    chmodSync(join(fakes, name), 0o755);
  }
  for (const dir of [".cursor", ".kiro", ".gemini", ".config/opencode", ".agents/plugins"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".gemini", "AGENTS.md"), "# My notes\n\nkeep this\n");
  writeFileSync(
    join(home, ".agents", "plugins", "marketplace.json"),
    JSON.stringify({ name: "local", plugins: [{ name: "other", source: { source: "local", path: "./plugins/other" } }] }, null, 2),
  );
  return { home, fakes, log: join(fakes, "calls.log") };
}

function setup(env: Env, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, "setup", ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: env.home, XDG_STATE_HOME: "", PATH: `${env.fakes}:${process.env.PATH}`, FAKE_LOG: env.log, FAKE_STATE: join(env.fakes, "state"), ...extra },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (path: string) => readFileSync(path, "utf8");
const calls = (env: Env) => (existsSync(env.log) ? read(env.log).trim().split("\n") : []);

describe("reel-mesh setup", () => {
  let env: Env;
  beforeEach(() => {
    env = makeEnv();
  });
  afterEach(() => {
    rmSync(join(env.home, ".."), { recursive: true, force: true });
  });

  it("without --yes prints the plan and changes nothing", () => {
    const r = setup(env, ["install", "--targets", "all"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /install targets: claude, codex, cursor, kiro, antigravity, opencode/);
    assert.equal(existsSync(join(env.home, ".cursor", "skills", "reel-mesh")), false);
    assert.deepEqual(calls(env), []);
  });

  it("installs every target in its own format and activates claude and codex", () => {
    const r = setup(env, ["install", "--targets", "all", "--yes"]);
    assert.equal(r.code, 0, r.out);
    const h = env.home;

    const cursor = read(join(h, ".cursor", "skills", "reel-mesh", "SKILL.md"));
    assert.match(cursor, /^---\ndescription: ".+"\nalwaysApply: false\n---\n# reel-mesh/);
    assert.ok(existsSync(join(h, ".cursor", "skills", "reel-mesh", "references", "selection.md")));

    const kiro = read(join(h, ".kiro", "steering", "reel-mesh.md"));
    assert.match(kiro, /^---\ninclusion: auto\nname: reel-mesh\ndescription: ".+"\n---\n/);
    assert.match(kiro, /#\[\[file:reel-mesh-ref-scenario-format\.md\]\]/);
    assert.doesNotMatch(kiro, /references\/scenario-format\.md/);
    assert.match(read(join(h, ".kiro", "steering", "reel-mesh-ref-selection.md")), /^---\ninclusion: manual\n/);

    const antigravity = read(join(h, ".gemini", "antigravity", "skills", "reel-mesh.md"));
    assert.match(antigravity, /^# reel-mesh\n\n> /);
    assert.match(antigravity, /<!-- \[See: references\/review-checklist\.md\] -->/);
    const agents = read(join(h, ".gemini", "AGENTS.md"));
    assert.ok(agents.startsWith("# My notes\n\nkeep this\n"));
    assert.equal(agents.split("<!-- reel-mesh:BEGIN -->").length, 2);

    const opencode = read(join(h, ".config", "opencode", "skills", "reel-mesh", "SKILL.md"));
    assert.match(opencode, /^---\nname: reel-mesh\ndescription: ".+"\ncompatibility: opencode\n---\n/);
    assert.match(opencode, /<!-- \[See: references\/selection\.md\] -->/);

    const plugin = join(h, "plugins", "reel-mesh");
    assert.match(JSON.parse(read(join(plugin, ".codex-plugin", "plugin.json"))).version, /^0\.1\.0\+codex\.local\.\d{14}$/);
    assert.match(JSON.parse(read(join(plugin, ".claude-plugin", "plugin.json"))).version, /^0\.1\.0\+claude\.local\.\d{14}$/);
    assert.ok(existsSync(join(plugin, "skills", "reel-mesh", "SKILL.md")));

    const market = JSON.parse(read(join(h, ".agents", "plugins", "marketplace.json")));
    assert.equal(market.name, "local");
    assert.deepEqual(market.plugins.map((p: { name: string }) => p.name), ["other", "reel-mesh"]);
    assert.deepEqual(market.plugins[1].source, { source: "local", path: "./plugins/reel-mesh" });

    const log = calls(env);
    assert.ok(log.includes(`claude plugin marketplace add ${plugin}`), log.join("\n"));
    assert.ok(log.includes("claude plugin install reel-mesh@reel-mesh -s user"));
    assert.ok(log.includes("codex plugin add reel-mesh@local"));
  });

  it("re-running install updates in place and keeps one AGENTS.md block", () => {
    assert.equal(setup(env, ["install", "--targets", "all", "--yes"]).code, 0);
    const r = setup(env, ["install", "--targets", "all", "--yes"]);
    assert.equal(r.code, 0, r.out);
    assert.equal(read(join(env.home, ".gemini", "AGENTS.md")).split("<!-- reel-mesh:BEGIN -->").length, 2);
    assert.ok(calls(env).includes("claude plugin update reel-mesh@reel-mesh -s user"));
  });

  it("refuses to overwrite a file it did not create unless --force", () => {
    const foreign = join(env.home, ".cursor", "skills", "reel-mesh", "SKILL.md");
    mkdirSync(join(foreign, ".."), { recursive: true });
    writeFileSync(foreign, "mine\n");
    const r = setup(env, ["install", "--targets", "cursor", "--yes"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL cursor: .*--force/);
    assert.equal(read(foreign), "mine\n");
    assert.equal(setup(env, ["install", "--targets", "cursor", "--yes", "--force"]).code, 0);
    assert.match(read(foreign), /alwaysApply: false/);
  });

  it("rolls back the codex marketplace entry when codex rejects the plugin", () => {
    const r = setup(env, ["install", "--targets", "codex", "--yes"], { FAKE_CODEX_FAIL: "1" });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL codex: codex plugin add reel-mesh@local/);
    const market = JSON.parse(read(join(env.home, ".agents", "plugins", "marketplace.json")));
    assert.deepEqual(market.plugins.map((p: { name: string }) => p.name), ["other"]);
  });

  it("uninstall removes only what install created and restores AGENTS.md", () => {
    assert.equal(setup(env, ["install", "--targets", "all", "--yes"]).code, 0);
    const r = setup(env, ["uninstall", "--yes"]);
    assert.equal(r.code, 0, r.out);
    const h = env.home;
    for (const path of [
      join(h, ".cursor", "skills", "reel-mesh"),
      join(h, ".kiro", "steering", "reel-mesh.md"),
      join(h, ".kiro", "steering", "reel-mesh-ref-selection.md"),
      join(h, ".gemini", "antigravity", "skills", "reel-mesh.md"),
      join(h, ".config", "opencode", "skills", "reel-mesh", "SKILL.md"),
      join(h, "plugins", "reel-mesh"),
    ]) {
      assert.equal(existsSync(path), false, path);
    }
    assert.equal(read(join(h, ".gemini", "AGENTS.md")), "# My notes\n\nkeep this\n");
    const market = JSON.parse(read(join(h, ".agents", "plugins", "marketplace.json")));
    assert.deepEqual(market.plugins.map((p: { name: string }) => p.name), ["other"]);
    const log = calls(env);
    assert.ok(log.includes("codex plugin remove reel-mesh@local"));
    assert.ok(log.includes("claude plugin uninstall reel-mesh@reel-mesh -s user"));
    assert.ok(log.includes("claude plugin marketplace remove reel-mesh"));
    assert.match(setup(env, ["status"]).out, /cursor: not installed/);
  });

  it("uninstalling one of claude and codex keeps the shared plugin folder for the other", () => {
    assert.equal(setup(env, ["install", "--targets", "claude,codex", "--yes"]).code, 0);
    assert.equal(setup(env, ["uninstall", "--targets", "codex", "--yes"]).code, 0);
    assert.ok(existsSync(join(env.home, "plugins", "reel-mesh", ".claude-plugin", "plugin.json")));
    assert.match(setup(env, ["status"]).out, /claude: installed/);
  });
});
