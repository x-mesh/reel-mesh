import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TARGETS = ["claude", "codex", "cursor", "kiro", "antigravity", "opencode"] as const;
export type Target = (typeof TARGETS)[number];

const NAME = "reel-mesh";
const PLUGIN_ID = `${NAME}@${NAME}`;
const BLOCK_BEGIN = "<!-- reel-mesh:BEGIN -->";
const BLOCK_END = "<!-- reel-mesh:END -->";
const PLUGIN_PAYLOAD = [".claude-plugin", ".codex-plugin", "skills", "LICENSE", "README.md"];
// claude/codex plugin commands may clone or refresh a marketplace; past this they are treated as failed, not waited on.
const CLIENT_TIMEOUT_MS = 120000;
export const EXIT_SETUP_FAILED = 1;
export const EXIT_SETUP_USAGE = 2;

interface Skill {
  description: string;
  body: string;
  references: { name: string; body: string }[];
  dir: string;
}

interface TargetRecord {
  files: string[];
  agentsBlock?: string;
  claudeMarketplaceAdded?: boolean;
  codexMarketplace?: string;
}

interface State {
  targets: Partial<Record<Target, TargetRecord>>;
}

export interface SetupContext {
  home: string;
  root: string;
  write: (line: string) => void;
}

export function defaultContext(write: (line: string) => void = console.log): SetupContext {
  return { home: process.env.HOME ?? homedir(), root: fileURLToPath(new URL("..", import.meta.url)), write };
}

const statePath = (ctx: SetupContext) => join(process.env.XDG_STATE_HOME || join(ctx.home, ".local", "state"), NAME, "installed.json");
const pluginDir = (ctx: SetupContext) => join(ctx.home, "plugins", NAME);
const codexMarketplacePath = (ctx: SetupContext) => join(ctx.home, ".agents", "plugins", "marketplace.json");

function readState(ctx: SetupContext): State {
  const path = statePath(ctx);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as State) : { targets: {} };
}

function writeState(ctx: SetupContext, state: State): void {
  const path = statePath(ctx);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

const onPath = (command: string): boolean => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

function run(command: string, args: string[]): { ok: boolean; stdout: string; detail: string } {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: CLIENT_TIMEOUT_MS });
  const detail = (result.error?.message ?? `${result.stderr ?? ""}${result.stdout ?? ""}`).trim().split("\n").slice(-3).join(" ");
  return { ok: result.status === 0, stdout: result.stdout ?? "", detail };
}

export function detectTargets(ctx: SetupContext): Target[] {
  const present: Record<Target, boolean> = {
    claude: onPath("claude"),
    codex: onPath("codex"),
    cursor: existsSync(join(ctx.home, ".cursor")),
    kiro: existsSync(join(ctx.home, ".kiro")),
    antigravity: existsSync(join(ctx.home, ".gemini")),
    opencode: existsSync(join(ctx.home, ".config", "opencode")) || onPath("opencode"),
  };
  return TARGETS.filter((t) => present[t]);
}

export function loadSkill(root: string): Skill {
  const dir = join(root, "skills", NAME);
  const text = readFileSync(join(dir, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`frontmatter not found: ${join(dir, "SKILL.md")}`);
  const description = /^description: (.+)$/m.exec(match[1]!)?.[1]?.trim();
  if (!description) throw new Error(`description not found: ${join(dir, "SKILL.md")}`);
  const refDir = join(dir, "references");
  const references = existsSync(refDir)
    ? readdirSync(refDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => ({ name: f.slice(0, -3), body: readFileSync(join(refDir, f), "utf8") }))
    : [];
  return { description, body: match[2]!.replace(/^\n+/, ""), references, dir };
}

const yamlString = (s: string): string => JSON.stringify(s);

function inlineReferences(skill: Skill): string {
  let body = skill.body.trimEnd() + "\n";
  for (const ref of skill.references) body += `\n---\n<!-- [See: references/${ref.name}.md] -->\n\n${ref.body.trimEnd()}\n`;
  return body;
}

interface FileOutput {
  path: string;
  content: string;
}

// File formats follow xm's renderers (xm/lib/install/transform) so each tool loads the skill the same way it loads xm.
export function renderFiles(target: Target, skill: Skill, home: string): FileOutput[] {
  switch (target) {
    case "cursor": {
      const base = join(home, ".cursor", "skills", NAME);
      return [
        { path: join(base, "SKILL.md"), content: `---\ndescription: ${yamlString(skill.description)}\nalwaysApply: false\n---\n${skill.body}` },
        ...skill.references.map((r) => ({ path: join(base, "references", `${r.name}.md`), content: r.body })),
      ];
    }
    case "kiro": {
      const base = join(home, ".kiro", "steering");
      const body = skill.body.replace(/`?references\/([\w-]+)\.md`?/g, (_, name: string) => `#[[file:${NAME}-ref-${name}.md]]`);
      return [
        { path: join(base, `${NAME}.md`), content: `---\ninclusion: auto\nname: ${NAME}\ndescription: ${yamlString(skill.description)}\n---\n${body}` },
        ...skill.references.map((r) => ({
          path: join(base, `${NAME}-ref-${r.name}.md`),
          content: `---\ninclusion: manual\ndescription: ${yamlString(`Reference: ${r.name} (companion to ${NAME}).`)}\n---\n${r.body}`,
        })),
      ];
    }
    case "antigravity":
      return [{ path: join(home, ".gemini", "antigravity", "skills", `${NAME}.md`), content: `# ${NAME}\n\n> ${skill.description}\n\n${inlineReferences(skill)}` }];
    case "opencode":
      return [
        {
          path: join(home, ".config", "opencode", "skills", NAME, "SKILL.md"),
          content: `---\nname: ${NAME}\ndescription: ${yamlString(skill.description)}\ncompatibility: opencode\n---\n${inlineReferences(skill)}`,
        },
      ];
    default:
      return [];
  }
}

export function agentsBlock(skill: Skill, skillFile: string): string {
  return `${BLOCK_BEGIN}\n## ${NAME}\n\n${skill.description}\n\nWhen a request matches, read \`${skillFile}\` and follow it.\n${BLOCK_END}\n`;
}

export function upsertBlock(text: string, block: string): string {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + BLOCK_END.length).replace(/^\n/, "");
  return (text.length > 0 && !text.endsWith("\n\n") ? text.replace(/\n?$/, "\n\n") : text) + block;
}

export function removeBlock(text: string): string {
  const start = text.indexOf(BLOCK_BEGIN);
  const end = text.indexOf(BLOCK_END);
  if (start < 0 || end < start) return text;
  const before = text.slice(0, start);
  const after = text.slice(end + BLOCK_END.length).replace(/^\n/, "");
  // upsertBlock separates an appended block with a blank line; drop it again when the block was last.
  return after === "" ? before.replace(/\n+$/, before.trim() === "" ? "" : "\n") : before + after;
}

function writeOwnedFiles(outputs: FileOutput[], owned: Set<string>, force: boolean): void {
  const foreign = outputs.filter((o) => existsSync(o.path) && !owned.has(o.path));
  if (foreign.length > 0 && !force) {
    throw new Error(`이 도구가 만들지 않은 파일이 이미 있어 덮어쓰지 않습니다: ${foreign.map((o) => o.path).join(", ")} (덮어쓰려면 --force)`);
  }
  for (const o of outputs) {
    mkdirSync(dirname(o.path), { recursive: true });
    writeFileSync(o.path, o.content);
  }
}

function stampVersion(path: string, suffix: string, stamp: string): void {
  const json = JSON.parse(readFileSync(path, "utf8")) as { version?: string; plugins?: { name: string; version?: string }[] };
  const versioned = (v: string | undefined) => `${String(v ?? "0.0.0").split("+")[0]}+${suffix}.${stamp}`;
  if (json.version !== undefined) json.version = versioned(json.version);
  for (const p of json.plugins ?? []) if (p.name === NAME) p.version = versioned(p.version);
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

// Claude Code and Codex cache plugins per version, so each local install gets a fresh build suffix to be picked up.
function copyPluginPayload(ctx: SetupContext, owned: boolean, force: boolean): void {
  const dir = pluginDir(ctx);
  if (existsSync(dir) && !owned && !force) throw new Error(`이 도구가 만들지 않은 폴더가 이미 있어 덮어쓰지 않습니다: ${dir} (덮어쓰려면 --force)`);
  rmSync(dir, { recursive: true, force: true });
  for (const entry of PLUGIN_PAYLOAD) {
    if (existsSync(join(ctx.root, entry))) cpSync(join(ctx.root, entry), join(dir, entry), { recursive: true });
  }
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  stampVersion(join(dir, ".claude-plugin", "plugin.json"), "claude.local", stamp);
  stampVersion(join(dir, ".claude-plugin", "marketplace.json"), "claude.local", stamp);
  stampVersion(join(dir, ".codex-plugin", "plugin.json"), "codex.local", stamp);
}

function codexMarketplaceName(ctx: SetupContext): string {
  const path = codexMarketplacePath(ctx);
  const json = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { name?: unknown }) : { name: "personal" };
  if (typeof json.name !== "string" || !/^[\w-]+$/.test(json.name)) throw new Error(`Codex 마켓플레이스 이름이 올바르지 않습니다: ${path}`);
  return json.name;
}

function updateCodexMarketplace(ctx: SetupContext, add: boolean): void {
  const path = codexMarketplacePath(ctx);
  const json = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as { name: string; plugins: { name: string }[] })
    : { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
  json.plugins = json.plugins.filter((p) => p.name !== NAME);
  if (add) {
    json.plugins.push({
      name: NAME,
      source: { source: "local", path: `./${relative(ctx.home, pluginDir(ctx))}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools",
    } as { name: string });
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
}

function claudeMarketplaceRegistered(): boolean {
  const out = run("claude", ["plugin", "marketplace", "list", "--json"]);
  return out.ok && (JSON.parse(out.stdout || "[]") as { name?: string }[]).some((m) => m.name === NAME);
}

function claudePluginInstalled(): boolean {
  const out = run("claude", ["plugin", "list", "--json"]);
  return out.ok && (JSON.parse(out.stdout || "[]") as { id?: string }[]).some((p) => p.id === PLUGIN_ID);
}

function installTarget(ctx: SetupContext, target: Target, skill: Skill, state: State, force: boolean): TargetRecord {
  const previous = state.targets[target];
  const owned = new Set(previous?.files ?? []);
  switch (target) {
    case "claude": {
      copyPluginPayload(ctx, Boolean(state.targets.claude ?? state.targets.codex), force);
      let added = previous?.claudeMarketplaceAdded ?? false;
      if (!claudeMarketplaceRegistered()) {
        const out = run("claude", ["plugin", "marketplace", "add", pluginDir(ctx)]);
        if (!out.ok) throw new Error(`claude plugin marketplace add 실패: ${out.detail}`);
        added = true;
      }
      const verb = claudePluginInstalled() ? "update" : "install";
      const out = run("claude", ["plugin", verb, PLUGIN_ID, "-s", "user"]);
      if (!out.ok) throw new Error(`claude plugin ${verb} 실패: ${out.detail}`);
      return { files: [pluginDir(ctx)], claudeMarketplaceAdded: added };
    }
    case "codex": {
      copyPluginPayload(ctx, Boolean(state.targets.claude ?? state.targets.codex), force);
      updateCodexMarketplace(ctx, true);
      const marketplace = codexMarketplaceName(ctx);
      const out = run("codex", ["plugin", "add", `${NAME}@${marketplace}`]);
      if (!out.ok) {
        updateCodexMarketplace(ctx, false);
        throw new Error(`codex plugin add ${NAME}@${marketplace} 실패: ${out.detail}`);
      }
      return { files: [pluginDir(ctx)], codexMarketplace: marketplace };
    }
    case "antigravity": {
      const outputs = renderFiles(target, skill, ctx.home);
      writeOwnedFiles(outputs, owned, force);
      const agents = join(ctx.home, ".gemini", "AGENTS.md");
      const current = existsSync(agents) ? readFileSync(agents, "utf8") : "";
      writeFileSync(agents, upsertBlock(current, agentsBlock(skill, outputs[0]!.path)));
      return { files: outputs.map((o) => o.path), agentsBlock: agents };
    }
    default: {
      const outputs = renderFiles(target, skill, ctx.home);
      writeOwnedFiles(outputs, owned, force);
      return { files: outputs.map((o) => o.path) };
    }
  }
}

function uninstallTarget(ctx: SetupContext, target: Target, record: TargetRecord, state: State): void {
  if (target === "claude") {
    if (claudePluginInstalled()) run("claude", ["plugin", "uninstall", PLUGIN_ID, "-s", "user"]);
    if (record.claudeMarketplaceAdded && claudeMarketplaceRegistered()) run("claude", ["plugin", "marketplace", "remove", NAME]);
  }
  if (target === "codex") {
    if (record.codexMarketplace && onPath("codex")) run("codex", ["plugin", "remove", `${NAME}@${record.codexMarketplace}`]);
    updateCodexMarketplace(ctx, false);
  }
  if (record.agentsBlock && existsSync(record.agentsBlock)) writeFileSync(record.agentsBlock, removeBlock(readFileSync(record.agentsBlock, "utf8")));
  const sharedPluginDir = pluginDir(ctx);
  const otherUsesPluginDir = (target === "claude" && state.targets.codex) || (target === "codex" && state.targets.claude);
  for (const file of record.files) {
    if (file === sharedPluginDir && otherUsesPluginDir) continue;
    rmSync(file, { recursive: true, force: true });
    pruneEmptyOwnDirs(dirname(file));
  }
}

// Only folders inside a `reel-mesh` folder are ours; a tool's own skills or steering folder is left in place even when empty.
function pruneEmptyOwnDirs(dir: string): void {
  while (dir.split(sep).includes(NAME) && existsSync(dir) && readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true });
    dir = dirname(dir);
  }
}

function parseTargets(value: string | undefined, ctx: SetupContext): Target[] | null {
  if (value === undefined) return detectTargets(ctx);
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (names.length === 1 && names[0] === "all") return [...TARGETS];
  return names.every((n): n is Target => (TARGETS as readonly string[]).includes(n)) ? names : null;
}

const USAGE = `usage: reel-mesh setup [install|uninstall|status] [--targets ${TARGETS.join(",")}|all] [--yes] [--force]`;

export function runSetup(args: string[], ctx: SetupContext = defaultContext()): number {
  const action = args[0] && !args[0].startsWith("--") ? args.shift()! : "install";
  let targetsArg: string | undefined;
  let yes = false;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--targets") targetsArg = args[++i];
    else if (arg === "--yes") yes = true;
    else if (arg === "--force") force = true;
    else {
      ctx.write(USAGE);
      return EXIT_SETUP_USAGE;
    }
  }
  if (!["install", "uninstall", "status"].includes(action)) {
    ctx.write(USAGE);
    return EXIT_SETUP_USAGE;
  }
  const state = readState(ctx);

  if (action === "status") {
    const detected = new Set(detectTargets(ctx));
    for (const target of TARGETS) {
      const record = state.targets[target];
      const missing = record?.files.filter((f) => !existsSync(f)) ?? [];
      const installed = record ? (missing.length === 0 ? "installed" : `incomplete (missing ${missing.join(", ")})`) : "not installed";
      ctx.write(`${target}: ${installed}${detected.has(target) ? "" : " (tool not detected)"}`);
    }
    ctx.write(`state: ${statePath(ctx)}`);
    return 0;
  }

  const targets = action === "uninstall" && targetsArg === undefined ? (Object.keys(state.targets) as Target[]) : parseTargets(targetsArg, ctx);
  if (targets === null) {
    ctx.write(USAGE);
    return EXIT_SETUP_USAGE;
  }
  if (targets.length === 0) {
    ctx.write(action === "install" ? "설치할 대상을 찾지 못했습니다. --targets로 지정하세요." : "설치 기록이 없습니다.");
    return action === "install" ? EXIT_SETUP_USAGE : 0;
  }
  ctx.write(`${action} targets: ${targets.join(", ")}`);
  if (!yes) {
    ctx.write("변경하지 않았습니다. 적용하려면 --yes를 붙여 다시 실행하세요.");
    return 0;
  }

  const skill = loadSkill(ctx.root);
  let failed = false;
  for (const target of targets) {
    try {
      if (action === "install") {
        state.targets[target] = installTarget(ctx, target, skill, state, force);
        ctx.write(`ok ${target}: ${state.targets[target]!.files.join(", ")}`);
      } else {
        const record = state.targets[target];
        if (!record) {
          ctx.write(`skip ${target}: 설치 기록이 없습니다`);
          continue;
        }
        uninstallTarget(ctx, target, record, state);
        delete state.targets[target];
        ctx.write(`removed ${target}`);
      }
    } catch (e) {
      failed = true;
      ctx.write(`FAIL ${target}: ${e instanceof Error ? e.message : String(e)}`);
    }
    writeState(ctx, state);
  }
  if (action === "install") ctx.write("새 세션을 시작해야 설치한 skill이 로드됩니다.");
  return failed ? EXIT_SETUP_FAILED : 0;
}
