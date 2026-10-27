import { loadScenario, ScenarioError } from "../src/scenario.ts";
import { runPrecheck } from "../src/precheck.ts";
import { openRunLog } from "../src/runlog.ts";
import { runRecord } from "../src/recorder.ts";
import { runRestore } from "../src/state.ts";
import { runAudit } from "../src/audit.ts";
import { runSetup } from "../src/setup.ts";
import { EgoBrowserAdapter } from "../src/browser/ego-browser.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import type { AdapterFactory } from "../src/browser/adapter.ts";
import type { RunLog } from "../src/runlog.ts";
import { dirname } from "node:path";
import { budgetSuggestion, ComposeError, DEFAULT_BUDGET_MB, defaultMp4Path, GIF_COLORS, runRender, runReview, workspaceOf } from "../src/compose.ts";
import type { RenderOptions } from "../src/compose.ts";

const EXIT_INVALID = 2;

function validate(file: string | undefined): number {
  if (!file) {
    console.error("usage: reel-mesh validate <scenario.yaml>");
    return EXIT_INVALID;
  }
  try {
    const s = loadScenario(file);
    console.log(`ok: ${s.name} (${s.screens.length} screens, ${s.steps.length} steps)`);
    return 0;
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
}

const ADAPTERS = ["playwright", "ego-browser"] as const;
type AdapterName = (typeof ADAPTERS)[number];

interface AdapterArgs {
  file: string | undefined;
  adapter: AdapterName;
}

function parseAdapterArgs(args: string[]): AdapterArgs | null {
  let file: string | undefined;
  let adapter: AdapterName = "playwright";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--adapter") {
      const next = args[++i] as AdapterName | undefined;
      if (!next || !ADAPTERS.includes(next)) return null;
      adapter = next;
    } else if (arg.startsWith("--") || file !== undefined) {
      return null;
    } else {
      file = arg;
    }
  }
  return { file, adapter };
}

function adapterFactory(name: AdapterName, log: RunLog): AdapterFactory {
  return name === "ego-browser" ? () => new EgoBrowserAdapter({ log, write: console.log }) : () => new PlaywrightAdapter();
}

const adapterUsage = (command: string) => `usage: reel-mesh ${command} <scenario.yaml> [--adapter ${ADAPTERS.join("|")}]`;

async function check(args: string[]): Promise<number> {
  const parsed = parseAdapterArgs(args);
  if (!parsed?.file) {
    console.error(adapterUsage("check"));
    return EXIT_INVALID;
  }
  try {
    const scenario = loadScenario(parsed.file);
    const log = openRunLog(scenario.name);
    return await runPrecheck(scenario, log, adapterFactory(parsed.adapter, log));
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
}

async function record(args: string[]): Promise<number> {
  const parsed = parseAdapterArgs(args);
  if (!parsed?.file) {
    console.error(adapterUsage("record"));
    return EXIT_INVALID;
  }
  try {
    const scenario = loadScenario(parsed.file);
    const log = openRunLog(scenario.name);
    const createAdapter = adapterFactory(parsed.adapter, log);
    const precheck = await runPrecheck(scenario, log, createAdapter);
    if (precheck !== 0) return precheck;
    return await runRecord(scenario, log, createAdapter);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
}

async function restore(args: string[]): Promise<number> {
  const parsed = parseAdapterArgs(args);
  if (!parsed?.file) {
    console.error(adapterUsage("restore"));
    return EXIT_INVALID;
  }
  try {
    const scenario = loadScenario(parsed.file);
    const log = openRunLog(scenario.name);
    return await runRestore(scenario, log, adapterFactory(parsed.adapter, log));
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
}

const AUDIT_USAGE = "usage: reel-mesh audit <scenario.yaml> --deny-file <path>";

function audit(args: string[]): number {
  const [file, flag, denyFile, ...extra] = args;
  if (!file || flag !== "--deny-file" || !denyFile || extra.length > 0) {
    console.error(AUDIT_USAGE);
    return EXIT_INVALID;
  }
  try {
    return runAudit(loadScenario(file), denyFile);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
}

const EXIT_FAILED = 1;

function failCompose(stage: string, e: unknown, logPath: string): number {
  if (!(e instanceof ComposeError)) throw e;
  console.error(`FAIL ${stage}: ${e.message}`);
  console.error(`log: ${logPath}`);
  return EXIT_FAILED;
}

async function review(file: string | undefined): Promise<number> {
  if (!file) {
    console.error("usage: reel-mesh review <scenario.yaml>");
    return EXIT_INVALID;
  }
  let scenario;
  try {
    scenario = loadScenario(file);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
  try {
    const result = await runReview(scenario);
    console.log(`review: ${result.contactSheet} (${result.sheetFrames} scenes), ${result.stepImages.length} step images in ${dirname(result.contactSheet)}`);
    return 0;
  } catch (e) {
    return failCompose("review", e, workspaceOf(scenario).logPath);
  }
}

const RENDER_USAGE = "usage: reel-mesh render <scenario.yaml> [--width <px>] [--colors <n>] [--budget-mb <n>] [--mp4 [path]]";

function parseRender(args: string[], scenarioName: string): RenderOptions | null {
  const options: RenderOptions = { width: null, colors: GIF_COLORS, budgetMb: DEFAULT_BUDGET_MB, mp4: null };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const next = args[i + 1];
    const number = () => {
      const n = Number(next);
      return next !== undefined && Number.isFinite(n) && n > 0 ? n : null;
    };
    if (flag === "--mp4") {
      options.mp4 = next !== undefined && !next.startsWith("--") ? (i++, next) : defaultMp4Path(scenarioName);
      continue;
    }
    const value = number();
    if (value === null) return null;
    i++;
    if (flag === "--width") options.width = Math.floor(value);
    else if (flag === "--colors") options.colors = Math.min(256, Math.max(2, Math.floor(value)));
    else if (flag === "--budget-mb") options.budgetMb = value;
    else return null;
  }
  return options;
}

async function render(args: string[]): Promise<number> {
  const [file, ...rest] = args;
  if (!file) {
    console.error(RENDER_USAGE);
    return EXIT_INVALID;
  }
  let scenario;
  try {
    scenario = loadScenario(file);
  } catch (e) {
    if (!(e instanceof ScenarioError)) throw e;
    for (const line of e.errors) console.error(line);
    return EXIT_INVALID;
  }
  const options = parseRender(rest, scenario.name);
  if (!options) {
    console.error(RENDER_USAGE);
    return EXIT_INVALID;
  }
  try {
    const result = await runRender(scenario, options);
    const mb = (result.gifBytes / 1024 / 1024).toFixed(2);
    console.log(`render: ${result.gif} (${result.gifWidth}px wide, ${mb}MB, ${(result.durationMs / 1000).toFixed(1)}s)`);
    if (result.mp4) console.log(`render: ${result.mp4}`);
    if (result.overBudget) {
      console.log(`WARN render: GIF ${mb}MB가 예산 ${options.budgetMb}MB를 넘습니다. 폭과 색 수를 줄여 다시 만들려면:`);
      console.log(`  ${budgetSuggestion(result, options, file)}`);
    }
    return 0;
  } catch (e) {
    return failCompose("render", e, workspaceOf(scenario).logPath);
  }
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, (args: string[]) => number | Promise<number>> = {
  validate: ([file]) => validate(file),
  check: (rest) => check(rest),
  record: (rest) => record(rest),
  restore: (rest) => restore(rest),
  review: ([file]) => review(file),
  render: (rest) => render(rest),
  audit: (rest) => audit(rest),
  setup: (rest) => runSetup(rest),
};

const run = command === undefined ? undefined : commands[command];
if (!run) {
  console.error(`usage: reel-mesh <${Object.keys(commands).join("|")}> ...`);
  process.exitCode = EXIT_INVALID;
} else {
  process.exitCode = await run(args);
}
