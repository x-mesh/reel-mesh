import { existsSync, readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchOptions } from "./precheck.ts";
import type { AdapterFactory, BrowserAdapter, PageId } from "./browser/adapter.ts";
import { withTimeout } from "./runlog.ts";
import type { RunLog } from "./runlog.ts";
import type { Scenario } from "./scenario.ts";
import { CLI_PATH } from "./runlog.ts";

export const EXIT_RESTORE_DIFF = 4;
export const EXIT_SNAPSHOT_LEFT = 5;

const SNAPSHOT_FILE = "state-snapshot.json";
const RESTORE_FILE = "state-restore.json";
const BROWSER_TIMEOUT_MS = 30000;
// An app that rewrites storage on a timer needs time to show it: a read right after the restore would miss the late write.
const LATE_WRITE_SETTLE_MS = 300;

export type OriginEntries = Record<string, string>;

export interface StateSnapshot {
  // The adapter that recorded; restoring through another adapter would compare against a different browser profile.
  adapter: string;
  origins: Record<string, OriginEntries>;
  // chrome.storage.local entries by extension name; values are JSON text so they compare like localStorage strings.
  chromeStorage: Record<string, OriginEntries>;
}

export interface StateDiff {
  origin: string;
  key: string;
  expected: string | null;
  actual: string | null;
}

export interface RestoreReport {
  equal: boolean;
  diffs: StateDiff[];
  error?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const snapshotPath = (outDir: string): string => join(outDir, SNAPSHOT_FILE);
export const restoreReportPath = (outDir: string): string => join(outDir, RESTORE_FILE);
export const hasSnapshot = (outDir: string): boolean => existsSync(snapshotPath(outDir));
export const hasStatePatterns = (scenario: Scenario): boolean => scenario.state.localStorage.length > 0 || scenario.state.chromeStorage.length > 0;
const hasLocalStoragePatterns = (scenario: Scenario): boolean => scenario.state.localStorage.length > 0;

const restoreCommand = (scenario: Scenario, adapter: string): string => `node ${CLI_PATH} restore ${scenario.file} --adapter ${adapter}`;

export function leftoverSnapshotMessage(scenario: Scenario, outDir: string): string[] {
  const { adapter } = JSON.parse(readFileSync(snapshotPath(outDir), "utf8")) as Partial<StateSnapshot>;
  return [
    `이전 녹화가 남긴 상태 스냅숏이 있어 녹화하지 않습니다: ${snapshotPath(outDir)}`,
    `먼저 복원하세요: ${restoreCommand(scenario, adapter ?? "playwright")}`,
  ];
}

function screenOrigins(scenario: Scenario): string[] {
  const origins = new Set<string>();
  for (const screen of scenario.screens) {
    if (screen.url !== null) origins.add(new URL(screen.url).origin);
  }
  return [...origins];
}

function extensionNames(scenario: Scenario): string[] {
  if (scenario.state.chromeStorage.length === 0) return [];
  return [...new Set(scenario.screens.flatMap((s) => (s.extension ? [s.extension.name] : [])))];
}

function blankUrl(scenario: Scenario, origin: string): string | null {
  return scenario.state.blankPath === null ? null : new URL(scenario.state.blankPath, origin).href;
}

// The clean start and the first read happen on the blank page when one is configured: loading the app first would let it
// write its defaults (for example a first-load value) before the snapshot, and that value would be saved as the user's own (F7).
function startUrl(scenario: Scenario, origin: string): string {
  const blank = blankUrl(scenario, origin);
  if (blank !== null) return blank;
  const screen = scenario.screens.find((s) => s.url !== null && new URL(s.url).origin === origin);
  return screen?.url ?? origin;
}

const patternsLiteral = (patterns: string[]): string => JSON.stringify(patterns);

const MATCHERS_SOURCE = `const __matchers = __patterns.map((p) => new RegExp("^" + p.split("*").map((s) => s.replace(/[^*\\w]/g, (c) => "\\\\" + c)).join(".*") + "$"));`;
const MATCHER_SOURCE = `${MATCHERS_SOURCE}
  const __keys = () => Object.keys(localStorage).filter((k) => __matchers.some((m) => m.test(k)));`;

export const readStateExpression = (patterns: string[]): string => `(() => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHER_SOURCE}
  const out = {};
  for (const k of __keys()) out[k] = localStorage.getItem(k);
  return out;
})()`;

export const clearStateExpression = (patterns: string[]): string => `(() => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHER_SOURCE}
  for (const k of __keys()) localStorage.removeItem(k);
})()`;

export const writeStateExpression = (patterns: string[], entries: OriginEntries): string => `(() => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHER_SOURCE}
  for (const k of __keys()) localStorage.removeItem(k);
  for (const [k, v] of Object.entries(${JSON.stringify(entries)})) localStorage.setItem(k, v);
})()`;

export const readExtensionStateExpression = (patterns: string[]): string => `(async () => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHERS_SOURCE}
  const all = await chrome.storage.local.get(null);
  const out = {};
  for (const k of Object.keys(all)) if (__matchers.some((m) => m.test(k))) out[k] = JSON.stringify(all[k]);
  return out;
})()`;

export const clearExtensionStateExpression = (patterns: string[]): string => `(async () => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHERS_SOURCE}
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => __matchers.some((m) => m.test(k))));
})()`;

export const writeExtensionStateExpression = (patterns: string[], entries: OriginEntries): string => `(async () => {
  const __patterns = ${patternsLiteral(patterns)};
  ${MATCHERS_SOURCE}
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => __matchers.some((m) => m.test(k))));
  const values = {};
  for (const [k, v] of Object.entries(${JSON.stringify(entries)})) values[k] = JSON.parse(v);
  await chrome.storage.local.set(values);
})()`;

// chrome.storage is reachable only from an extension page, so each access opens the extension's own page unpinned.
async function withExtensionPage<T>(scenario: Scenario, adapter: BrowserAdapter, name: string, work: (page: PageId) => Promise<T>): Promise<T> {
  const extension = scenario.screens.find((s) => s.extension?.name === name)?.extension;
  if (!extension) throw new Error(`시나리오에 확장 '${name}'이 없습니다`);
  const id = await adapter.findExtensionId(name);
  if (id === null) throw new Error(`확장 '${name}'을 찾지 못했습니다`);
  const page = await adapter.openExtensionPage(id, extension.page, null);
  try {
    return await work(page);
  } finally {
    await adapter.closePage(page).catch(() => undefined);
  }
}

async function withTempPage<T>(adapter: BrowserAdapter, url: string, work: (page: PageId) => Promise<T>): Promise<T> {
  const page = await adapter.openPage();
  try {
    await adapter.goto(page, url);
    return await work(page);
  } finally {
    await adapter.closePage(page).catch(() => undefined);
  }
}

export async function writeSnapshotFile(outDir: string, snapshot: StateSnapshot): Promise<void> {
  await writeFile(snapshotPath(outDir), JSON.stringify(snapshot, null, 2));
}

export async function readSnapshotFile(outDir: string): Promise<StateSnapshot> {
  const parsed = JSON.parse(await readFile(snapshotPath(outDir), "utf8")) as Partial<StateSnapshot>;
  return { adapter: parsed.adapter ?? "", origins: parsed.origins ?? {}, chromeStorage: parsed.chromeStorage ?? {} };
}

// The snapshot file is complete on disk before any stored value is cleared; the caller clears afterward with clearState.
export async function captureSnapshot(scenario: Scenario, adapter: BrowserAdapter, outDir: string): Promise<StateSnapshot> {
  const snapshot: StateSnapshot = { adapter: adapter.name, origins: {}, chromeStorage: {} };
  if (hasLocalStoragePatterns(scenario)) {
    for (const origin of screenOrigins(scenario)) {
      snapshot.origins[origin] = await withTempPage(adapter, startUrl(scenario, origin), (page) =>
        adapter.evaluate<OriginEntries>(page, readStateExpression(scenario.state.localStorage)),
      );
    }
  }
  for (const name of extensionNames(scenario)) {
    snapshot.chromeStorage[name] = await withExtensionPage(scenario, adapter, name, (page) =>
      adapter.evaluate<OriginEntries>(page, readExtensionStateExpression(scenario.state.chromeStorage)),
    );
  }
  await writeSnapshotFile(outDir, snapshot);
  return snapshot;
}

export async function clearState(scenario: Scenario, adapter: BrowserAdapter, snapshot: StateSnapshot): Promise<void> {
  for (const origin of Object.keys(snapshot.origins)) {
    await withTempPage(adapter, startUrl(scenario, origin), (page) =>
      adapter.evaluate(page, clearStateExpression(scenario.state.localStorage)),
    );
  }
  for (const name of Object.keys(snapshot.chromeStorage)) {
    await withExtensionPage(scenario, adapter, name, (page) => adapter.evaluate(page, clearExtensionStateExpression(scenario.state.chromeStorage)));
  }
}

function diffEntries(origin: string, expected: OriginEntries, actual: OriginEntries): StateDiff[] {
  const diffs: StateDiff[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const before = expected[key] ?? null;
    const after = actual[key] ?? null;
    if (before !== after) diffs.push({ origin, key, expected: before, actual: after });
  }
  return diffs;
}

async function restoreOrigin(
  scenario: Scenario,
  adapter: BrowserAdapter,
  origin: string,
  expected: OriginEntries,
  pages: Map<string, PageId>,
): Promise<StateDiff[]> {
  const patterns = scenario.state.localStorage;
  const open = scenario.screens.filter((s) => s.url !== null && new URL(s.url).origin === origin && pages.has(s.id)).map((s) => pages.get(s.id)!);
  const blank = blankUrl(scenario, origin);
  const viaBlank = scenario.state.restoreViaBlankOrigin && blank !== null;

  const apply = async (page: PageId, settleMs: number): Promise<StateDiff[]> => {
    await adapter.evaluate(page, writeStateExpression(patterns, expected));
    if (settleMs > 0) await sleep(settleMs);
    return diffEntries(origin, expected, await adapter.evaluate<OriginEntries>(page, readStateExpression(patterns)));
  };

  if (viaBlank) {
    // Every page of the origin leaves the app first, so no app timer can write the keys again between restore and readback (F8).
    for (const page of open) await adapter.goto(page, blank);
    if (open.length > 0) return apply(open[0], 0);
    return withTempPage(adapter, blank, (page) => apply(page, 0));
  }
  if (open.length > 0) return apply(open[0], LATE_WRITE_SETTLE_MS);
  return withTempPage(adapter, startUrl(scenario, origin), (page) => apply(page, LATE_WRITE_SETTLE_MS));
}

async function restoreExtension(scenario: Scenario, adapter: BrowserAdapter, name: string, expected: OriginEntries): Promise<StateDiff[]> {
  const patterns = scenario.state.chromeStorage;
  return withExtensionPage(scenario, adapter, name, async (page) => {
    await adapter.evaluate(page, writeExtensionStateExpression(patterns, expected));
    await sleep(LATE_WRITE_SETTLE_MS);
    return diffEntries(`chrome.storage:${name}`, expected, await adapter.evaluate<OriginEntries>(page, readExtensionStateExpression(patterns)));
  });
}

// Restores the snapshot, compares the stored values with it, and removes the snapshot only when they are equal.
export async function restoreState(
  scenario: Scenario,
  adapter: BrowserAdapter,
  snapshot: StateSnapshot,
  pages: Map<string, PageId>,
  outDir: string,
  log: RunLog,
  write: (line: string) => void,
): Promise<RestoreReport> {
  let report: RestoreReport;
  try {
    const diffs: StateDiff[] = [];
    for (const [origin, expected] of Object.entries(snapshot.origins)) {
      diffs.push(...(await withTimeout(`상태 복원 ${origin}`, BROWSER_TIMEOUT_MS, () => restoreOrigin(scenario, adapter, origin, expected, pages))));
    }
    for (const [name, expected] of Object.entries(snapshot.chromeStorage)) {
      diffs.push(...(await withTimeout(`상태 복원 ${name}`, BROWSER_TIMEOUT_MS, () => restoreExtension(scenario, adapter, name, expected))));
    }
    report = { equal: diffs.length === 0, diffs };
  } catch (e) {
    report = { equal: false, diffs: [], error: message(e) };
  }
  await writeFile(restoreReportPath(outDir), JSON.stringify(report, null, 2));
  if (report.equal) {
    await rm(snapshotPath(outDir), { force: true });
    log.line("state", "restored equal", 0);
    write(`state restored: 저장값이 녹화 전과 같습니다 (${restoreReportPath(outDir)})`);
  } else {
    log.line("state", `restore differs diffs=${report.diffs.length}${report.error ? ` error=${report.error}` : ""}`, 0);
    const why = report.error ? `복원 실패: ${report.error}` : `녹화 전과 다른 키 ${report.diffs.length}개`;
    write(`STATE RESTORE FAILED: ${why}. 스냅숏을 남겼습니다: ${snapshotPath(outDir)}`);
    write(`결과: ${restoreReportPath(outDir)}. 다시 복원: ${restoreCommand(scenario, snapshot.adapter)}`);
  }
  return report;
}

export async function runRestore(scenario: Scenario, log: RunLog, createAdapter: AdapterFactory, write: (line: string) => void = console.log): Promise<number> {
  const outDir = dirname(log.path);
  if (!hasSnapshot(outDir)) {
    write(`복원할 스냅숏이 없습니다: ${snapshotPath(outDir)}`);
    return 0;
  }
  const snapshot = await readSnapshotFile(outDir);
  const adapter = createAdapter();
  if (snapshot.adapter !== adapter.name) {
    write(`FAIL restore: 스냅숏은 '${snapshot.adapter}' 어댑터로 녹화한 상태입니다. 다른 어댑터로 복원하면 다른 브라우저 프로필을 비교하게 됩니다`);
    write(`할 일: ${restoreCommand(scenario, snapshot.adapter)}`);
    return 2;
  }
  try {
    try {
      await withTimeout("브라우저 실행", BROWSER_TIMEOUT_MS, () => adapter.launch(launchOptions(scenario)));
    } catch (e) {
      log.line("state", `restore launch fail ${message(e)}`, 0);
      write(`FAIL restore: 브라우저를 실행하지 못했습니다 (${message(e)})`);
      return 1;
    }
    const report = await restoreState(scenario, adapter, snapshot, new Map(), outDir, log, write);
    return report.equal ? 0 : EXIT_RESTORE_DIFF;
  } finally {
    await withTimeout("브라우저 종료", BROWSER_TIMEOUT_MS, () => adapter.close()).catch((e) => log.line("state:브라우저 종료", `fail ${message(e)}`, 0));
  }
}
