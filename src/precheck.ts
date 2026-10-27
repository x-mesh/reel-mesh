import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AdapterFactory, BrowserAdapter, LaunchOptions, PageId } from "./browser/adapter.ts";
import type { Scenario, Target } from "./scenario.ts";
import { withTimeout } from "./runlog.ts";
import type { RunLog } from "./runlog.ts";

export const EXIT_PRECHECK_FAILED = 3;

const FFMPEG_TIMEOUT_MS = 5000;
const SERVER_TIMEOUT_MS = 5000;
const BROWSER_TIMEOUT_MS = 30000;

// In-page resolver shared by check and the recorder. It returns every element matching a Target,
// so callers can reject 0 or 2+ matches instead of silently taking the first.
export const TARGET_RESOLVER_SOURCE = `
function __reelFind(root, t) {
  if (t.kind === "css") return Array.from(root.querySelectorAll(t.selector));
  if (t.kind === "text") {
    const has = (e) => (e.textContent || "").includes(t.text);
    return Array.from(root.querySelectorAll("*")).filter((e) => has(e) && !Array.from(e.children).some(has));
  }
  if (t.kind === "shadow") {
    return Array.from(root.querySelectorAll(t.host)).flatMap((h) => (h.shadowRoot ? Array.from(h.shadowRoot.querySelectorAll(t.inner)) : []));
  }
  return Array.from(root.querySelectorAll(t.frame)).flatMap((f) => (f.contentDocument ? __reelFind(f.contentDocument, t.target) : []));
}
`;

export function countTargetExpression(target: Target): string {
  return `(() => { ${TARGET_RESOLVER_SOURCE} return __reelFind(document, ${JSON.stringify(target)}).length; })()`;
}

export function describeTarget(t: Target): string {
  switch (t.kind) {
    case "css":
      return t.selector;
    case "text":
      return `text "${t.text}"`;
    case "shadow":
      return `${t.host} >> shadow >> ${t.inner}`;
    case "frame":
      return `${t.frame} >> frame >> ${describeTarget(t.target)}`;
  }
}

// Contract with the panel page: it exposes the tab id it is bound to, so the pin can be verified before recording (F4).
const PINNED_TAB_EXPRESSION = "window.__reelPinnedTabId";

export class PinError extends Error {}

const extensionDir = (scenario: Scenario, path: string): string => resolve(dirname(scenario.file), path);

export function launchOptions(scenario: Scenario): LaunchOptions {
  const paths = scenario.screens.flatMap((s) => (s.extension ? [extensionDir(scenario, s.extension.path)] : []));
  return { extensionPaths: [...new Set(paths)] };
}

// Opens the panel for a pinned screen and fails unless the panel reports the same tab id the browser assigns to the target page.
export async function openVerifiedPanel(adapter: BrowserAdapter, extensionId: string, page: string, target: PageId): Promise<PageId> {
  const expected = await adapter.tabIdOf(extensionId, page, target);
  const panel = await adapter.openExtensionPage(extensionId, page, target);
  try {
    const actual = await adapter.evaluate<number | null | undefined>(panel, PINNED_TAB_EXPRESSION);
    if (typeof actual !== "number") throw new PinError("패널이 묶인 탭 ID를 'window.__reelPinnedTabId'로 노출하지 않습니다");
    if (actual !== expected) throw new PinError(`패널이 대상 탭에 붙지 않았습니다 (대상 탭 ${expected}, 패널이 받은 탭 ${actual})`);
  } catch (error) {
    await adapter.closePage(panel).catch(() => undefined);
    throw error;
  }
  return panel;
}

export interface FirstTarget {
  screen: string;
  url: string | null;
  target: Target;
}

export function firstTarget(scenario: Scenario): FirstTarget | null {
  const urls = new Map(scenario.screens.map((s) => [s.id, s.url]));
  for (const { action } of scenario.steps) {
    if (action.kind === "goto") urls.set(action.screen, action.url);
    let found: { screen: string; target: Target } | null = null;
    if (action.kind === "click" || action.kind === "dblclick" || action.kind === "type") found = { screen: action.screen, target: action.target };
    else if (action.kind === "drag") found = { screen: action.screen, target: action.from };
    else if (action.kind === "expect") found = { screen: action.screen, target: { kind: "css", selector: action.selector } };
    if (found) return { ...found, url: urls.get(found.screen) ?? null };
  }
  return null;
}

export type CheckStatus = "ok" | "skip" | "fail";

export interface CheckItem {
  name: string;
  status: CheckStatus;
  detail: string;
  todo: string | null;
}

const ok = (name: string, detail = ""): CheckItem => ({ name, status: "ok", detail, todo: null });
const skip = (name: string, detail: string): CheckItem => ({ name, status: "skip", detail, todo: null });
const fail = (name: string, detail: string, todo: string): CheckItem => ({ name, status: "fail", detail, todo });

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function checkFfmpeg(): Promise<CheckItem> {
  const name = "ffmpeg";
  const todo = "ffmpeg를 설치하고 PATH에 추가한 뒤 'ffmpeg -version'이 동작하는지 확인하세요.";
  return withTimeout(name, FFMPEG_TIMEOUT_MS, () =>
    new Promise<CheckItem>((resolve) => {
      const child = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.once("error", (e) => resolve(fail(name, `ffmpeg를 실행하지 못했습니다 (${message(e)})`, todo)));
      child.once("close", (code) =>
        resolve(code === 0 ? ok(name, out.split("\n")[0]) : fail(name, `'ffmpeg -version'이 exit ${code}로 끝났습니다`, todo)),
      );
    }),
  ).catch((e) => fail(name, message(e), todo));
}

function serverUrls(scenario: Scenario): string[] {
  const all = [
    ...scenario.screens.flatMap((s) => (s.url ? [s.url] : [])),
    ...scenario.steps.flatMap((s) => (s.action.kind === "goto" ? [s.action.url] : [])),
  ];
  const byOrigin = new Map<string, string>();
  for (const u of all) {
    try {
      const origin = new URL(u).origin;
      if (!byOrigin.has(origin)) byOrigin.set(origin, u);
    } catch {
      byOrigin.set(u, u);
    }
  }
  return [...byOrigin.values()];
}

async function checkServer(scenario: Scenario): Promise<CheckItem> {
  const name = "개발 서버";
  const urls = serverUrls(scenario);
  if (urls.length === 0) return skip(name, "시나리오에 URL 화면이 없습니다");
  for (const url of urls) {
    const todo = `${url}에서 개발 서버를 시작한 뒤 다시 실행하세요.`;
    try {
      const res = await withTimeout(name, SERVER_TIMEOUT_MS, async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
        try {
          return await fetch(url, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      });
      await res.body?.cancel();
      if (!res.ok) return fail(name, `GET ${url}이 HTTP ${res.status}를 반환했습니다`, todo);
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause?.code;
      return fail(name, `GET ${url} 실패 (${cause ?? message(e)})`, todo);
    }
  }
  return ok(name, urls.join(", "));
}

async function checkFirstTarget(scenario: Scenario, adapter: BrowserAdapter): Promise<CheckItem> {
  const name = "첫 대상 요소";
  const first = firstTarget(scenario);
  if (!first) return skip(name, "시나리오에 대상이 있는 단계가 없습니다");
  const screen = scenario.screens.find((s) => s.id === first.screen);
  if (!screen || screen.extension) return skip(name, `'${first.screen}'은 확장 화면이라 대상 요소 대신 확장 항목에서 점검합니다`);
  if (!first.url) return skip(name, `'${first.screen}' 화면에 URL이 없습니다`);
  const todo = `${first.url} 첫 화면에 '${describeTarget(first.target)}' 요소가 하나만 있도록 시나리오의 대상을 고치세요.`;
  const url = first.url;
  try {
    const count = await withTimeout(name, scenario.timing.stepTimeoutMs, async () => {
      const page = await adapter.openPage();
      await adapter.setViewport(page, screen.width, screen.height, screen.scale);
      await adapter.goto(page, url);
      return await adapter.evaluate<number>(page, countTargetExpression(first.target));
    });
    if (count === 1) return ok(name, describeTarget(first.target));
    return fail(name, `'${describeTarget(first.target)}'가 ${url}에서 ${count}개 일치합니다 (1개여야 합니다)`, todo);
  } catch (e) {
    return fail(name, `${url} 첫 화면을 점검하지 못했습니다 (${message(e)})`, todo);
  }
}

async function checkExtension(scenario: Scenario, adapter: BrowserAdapter): Promise<CheckItem> {
  const name = "확장";
  const found: string[] = [];
  const seen = new Set<string>();
  for (const screen of scenario.screens) {
    const extension = screen.extension;
    if (!extension || seen.has(extension.name)) continue;
    seen.add(extension.name);
    const dir = extensionDir(scenario, extension.path);
    if (!existsSync(join(dir, "manifest.json"))) {
      return fail(name, `${dir}에 manifest.json이 없습니다`, `화면 '${screen.id}'의 extension.path가 manifest.json이 있는 확장 폴더를 가리키게 고치세요.`);
    }
    const id = await withTimeout(name, BROWSER_TIMEOUT_MS, () => adapter.findExtensionId(extension.name)).catch(() => null);
    if (id === null) {
      return fail(
        name,
        `'${extension.name}' 확장을 찾지 못했습니다 (로드한 폴더 ${dir})`,
        `extension.name을 manifest.json의 name과 같게 고치고, 확장에 background service worker가 있는지 확인하세요.`,
      );
    }
    found.push(`${extension.name} (id ${id})`);
  }
  return ok(name, found.join(", "));
}

async function checkPinning(scenario: Scenario, adapter: BrowserAdapter): Promise<CheckItem> {
  const name = "대상 탭 고정";
  const pinned = scenario.screens.filter((s) => s.extension?.pinTo);
  if (pinned.length === 0) return skip(name, "pinTo가 지정된 확장 화면이 없습니다");
  const details: string[] = [];
  for (const screen of pinned) {
    const extension = screen.extension!;
    const target = scenario.screens.find((s) => s.id === extension.pinTo);
    const todo = `화면 '${screen.id}'의 pinTo가 URL이 있는 화면의 id를 가리키는지, 패널이 ?tab 값을 받아 window.__reelPinnedTabId로 노출하는지 확인하세요.`;
    if (!target || target.url === null) return fail(name, `pinTo '${extension.pinTo}'는 URL이 있는 화면이 아닙니다`, todo);
    const targetUrl = target.url;
    let targetPage: PageId | undefined;
    try {
      const id = await adapter.findExtensionId(extension.name);
      if (id === null) return fail(name, `'${extension.name}' 확장을 찾지 못했습니다`, todo);
      await withTimeout(name, scenario.timing.stepTimeoutMs, async () => {
        targetPage = await adapter.openPage();
        await adapter.setViewport(targetPage, target.width, target.height, target.scale);
        await adapter.goto(targetPage, targetUrl);
        await adapter.closePage(await openVerifiedPanel(adapter, id, extension.page, targetPage));
      });
      details.push(`${screen.id} -> ${target.id}`);
    } catch (e) {
      return fail(name, `${message(e)}`, todo);
    } finally {
      if (targetPage !== undefined) await adapter.closePage(targetPage).catch(() => undefined);
    }
  }
  return ok(name, details.join(", "));
}

export async function runPrecheck(scenario: Scenario, log: RunLog, createAdapter: AdapterFactory, write: (line: string) => void = console.log): Promise<number> {
  const items: CheckItem[] = [];
  const record = (item: CheckItem) => {
    items.push(item);
    log.line(`check:${item.name}`, `${item.status}${item.detail ? ` ${item.detail}` : ""}`, 0);
    const suffix = item.detail ? `: ${item.detail}` : "";
    if (item.status === "fail") write(`FAIL ${item.name}: ${item.detail}\n할 일: ${item.todo}`);
    else write(`${item.status} ${item.name}${suffix}`);
  };

  record(await checkFfmpeg());
  const server = await checkServer(scenario);
  record(server);

  const hasExtension = scenario.screens.some((s) => s.extension);
  const serverDown = server.status === "fail";

  if (serverDown) {
    record(skip("브라우저 실행", "개발 서버 점검이 실패해 건너뜁니다"));
  } else {
    const adapter = createAdapter();
    try {
      const launched = await withTimeout("브라우저 실행", BROWSER_TIMEOUT_MS, () => adapter.launch(launchOptions(scenario))).then(
        () => ok("브라우저 실행"),
        (e) => fail("브라우저 실행", message(e), "'npx playwright install chromium'을 실행한 뒤 다시 시도하세요."),
      );
      record(launched);
      if (!hasExtension) record(skip("확장", "시나리오에 확장 화면이 없습니다"));
      else if (launched.status === "fail") record(skip("확장", "브라우저 실행이 실패해 건너뜁니다"));
      else {
        const extension = await checkExtension(scenario, adapter);
        record(extension);
        record(extension.status === "ok" ? await checkPinning(scenario, adapter) : skip("대상 탭 고정", "확장 점검이 실패해 건너뜁니다"));
      }
      if (launched.status === "fail") record(skip("첫 대상 요소", "브라우저 실행이 실패해 건너뜁니다"));
      else record(await checkFirstTarget(scenario, adapter));
    } finally {
      await withTimeout("브라우저 종료", BROWSER_TIMEOUT_MS, () => adapter.close()).catch((e) => log.line("check:브라우저 종료", `fail ${message(e)}`, 0));
    }
    return finish(items, log, write);
  }
  record(skip("확장", hasExtension ? "개발 서버 점검이 실패해 건너뜁니다" : "시나리오에 확장 화면이 없습니다"));
  record(skip("첫 대상 요소", "개발 서버 점검이 실패해 건너뜁니다"));
  return finish(items, log, write);
}

function finish(items: CheckItem[], log: RunLog, write: (line: string) => void): number {
  const failed = items.filter((i) => i.status === "fail").length;
  write(failed === 0 ? "check: 모두 통과" : `check: ${failed}개 항목 실패`);
  log.line("check", failed === 0 ? "pass" : `fail ${failed}`, 0);
  return failed === 0 ? 0 : EXIT_PRECHECK_FAILED;
}
