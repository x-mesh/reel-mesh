import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAdapter, LaunchOptions, MouseButton, PageId } from "./adapter.ts";
import type { RunLog } from "../runlog.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const NOTICE_PREFIX = "[ego-browser:";
const UPDATE_NOTICE = "[ego-browser:notice]";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const STDERR_TAIL_CHARS = 400;
const FAILURE_CAUSES = "원인 후보: ego-browser가 종료되었거나, 연결이 끊겼거나, 사용자가 브라우저 제어를 가져갔습니다.";

export interface EgoBrowserOptions {
  executable?: string;
  timeoutMs?: number;
  log?: RunLog;
  write?: (line: string) => void;
}

interface Invocation {
  value: unknown;
  notices: string[];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const unsupported = (method: string, reason: string): Error => new Error(`unsupported: ${method} — ${reason}`);

// The script runs inside ego-browser, not in this process: it inherits neither env nor cwd (ego-browser skill v2.1.0),
// so every value is written into the text. The result line carries a per-invocation token so output printed by anything
// else, including the page-controlled text of an error, cannot be mistaken for the result.
function buildScript(token: string, taskLine: string, body: string): string {
  return `${taskLine}
let value = null;
let error = null;
try {
${body}
} catch (e) {
  error = String((e && e.message) || e);
}
console.log(${JSON.stringify(`REEL-RESULT ${token} `)} + JSON.stringify(error === null ? { ok: true, value: value === undefined ? null : value } : { ok: false, error }));
`;
}

export class EgoBrowserAdapter implements BrowserAdapter {
  readonly name = "ego-browser";
  readonly #executable: string;
  readonly #timeoutMs: number;
  readonly #log: RunLog | undefined;
  readonly #write: (line: string) => void;
  #spaceId: number | undefined;
  #finished = false;
  #firstPageReady = false;
  #pages = new Set<PageId>();
  #shotDir: string | undefined;
  #shotSeq = 0;
  #notices: string[] = [];

  constructor(options: EgoBrowserOptions = {}) {
    this.#executable = options.executable ?? "ego-browser";
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#log = options.log;
    this.#write = options.write ?? (() => undefined);
  }

  async launch(options: LaunchOptions = {}): Promise<void> {
    if (this.#spaceId !== undefined) throw new Error("already launched");
    if ((options.extensionPaths ?? []).length > 0) {
      throw unsupported("launch", "ego-browser 문서에 확장 프로그램을 로드하는 방법이 없습니다 (확장 화면이 있는 시나리오는 playwright 어댑터로 녹화하세요)");
    }
    this.#shotDir = await mkdtemp(join(tmpdir(), "reel-mesh-ego-"));
    try {
      const name = `reel-mesh-${randomUUID().slice(0, 8)}`;
      const value = await this.#invoke(
        `const task = await taskSpace(${JSON.stringify(name)});`,
        `value = { spaceId: task.spaceId, page: task.page("p1").label };`,
      );
      const created = value as { spaceId?: unknown; page?: unknown } | null;
      if (typeof created?.spaceId !== "number" || created.page !== "p1") {
        throw new Error(`taskSpace 생성 결과를 해석하지 못했습니다: ${JSON.stringify(value)}`);
      }
      this.#spaceId = created.spaceId;
    } catch (error) {
      await rm(this.#shotDir, { recursive: true, force: true });
      this.#shotDir = undefined;
      throw error;
    }
  }

  async openPage(): Promise<PageId> {
    // A new task space starts with Page p1, which the skill says to reuse before opening another.
    if (!this.#firstPageReady) {
      this.#firstPageReady = true;
      this.#pages.add("p1");
      return "p1";
    }
    const label = await this.#run(`const page = await task.newPage(); value = page.label;`);
    if (typeof label !== "string") throw new Error(`newPage 결과를 해석하지 못했습니다: ${JSON.stringify(label)}`);
    this.#pages.add(label);
    return label;
  }

  async closePage(page: PageId): Promise<void> {
    this.#known(page);
    await this.#onPage(page, `await page.close();`);
    this.#pages.delete(page);
  }

  async goto(page: PageId, url: string): Promise<void> {
    await this.#onPage(page, `await page.goto(${JSON.stringify(url)});`);
  }

  // The skill documents no viewport API, only page.cdp() for Page/Runtime/DOM/Network/Input "and similar" commands.
  // Whether Emulation passes is unverified (docs/spike-notes.md), so a rejection surfaces as this method's failure.
  async setViewport(page: PageId, width: number, height: number, scale = 1): Promise<void> {
    await this.#onPage(
      page,
      `await page.cdp("Emulation.setDeviceMetricsOverride", ${JSON.stringify({ width, height, deviceScaleFactor: scale, mobile: false })});`,
    );
  }

  async screenshot(page: PageId): Promise<Uint8Array> {
    if (!this.#shotDir) throw new Error("browser not launched");
    const path = join(this.#shotDir, `shot-${this.#shotSeq++}.png`);
    await this.#onPage(page, `await page.screenshot({ path: ${JSON.stringify(path)} });`);
    const bytes = await readFile(path);
    await rm(path, { force: true });
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw unsupported("screenshot", "page.screenshot()가 PNG가 아닌 파일을 만들었습니다 (형식 옵션이 문서에 없습니다)");
    }
    return new Uint8Array(bytes);
  }

  async mouseMove(page: PageId, x: number, y: number): Promise<void> {
    await this.#onPage(page, `await page.mouse.move(${x}, ${y});`);
  }

  async mouseDown(page: PageId, button: MouseButton = "left"): Promise<void> {
    if (button !== "left") throw unsupported("mouseDown", "page.mouse.down()의 버튼 옵션이 문서에 없습니다 (left만 지원)");
    await this.#onPage(page, `await page.mouse.down();`);
  }

  async mouseUp(page: PageId, button: MouseButton = "left"): Promise<void> {
    if (button !== "left") throw unsupported("mouseUp", "page.mouse.up()의 버튼 옵션이 문서에 없습니다 (left만 지원)");
    await this.#onPage(page, `await page.mouse.up();`);
  }

  // mouse.click() documents only a `label` option, so a click count above 1 goes through page.cdp() Input events,
  // matching the Playwright adapter's single press that carries the count.
  async mouseClick(page: PageId, x: number, y: number, clickCount = 1): Promise<void> {
    if (!Number.isInteger(clickCount) || clickCount < 1) throw unsupported("mouseClick", `클릭 횟수 ${clickCount}`);
    if (clickCount === 1) {
      await this.#onPage(page, `await page.mouse.click(${x}, ${y});`);
      return;
    }
    const event = (type: string) => JSON.stringify({ type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount });
    await this.#onPage(
      page,
      `await page.mouse.move(${x}, ${y});
await page.cdp("Input.dispatchMouseEvent", ${event("mousePressed")});
await page.cdp("Input.dispatchMouseEvent", ${event("mouseReleased")});`,
    );
  }

  async keyboardType(page: PageId, text: string): Promise<void> {
    await this.#onPage(page, `await page.keyboard.type(${JSON.stringify(text)});`);
  }

  async keyboardPress(page: PageId, key: string): Promise<void> {
    await this.#onPage(page, `await page.keyboard.press(${JSON.stringify(key)});`);
  }

  async findExtensionId(_name: string): Promise<string | null> {
    throw unsupported("findExtensionId", "ego-browser 문서에 확장 프로그램을 찾는 방법이 없습니다");
  }

  async openExtensionPage(_extensionId: string, _path: string, _pinTo: PageId | null): Promise<PageId> {
    throw unsupported("openExtensionPage", "ego-browser 문서에 chrome-extension:// 화면을 여는 방법이 없습니다");
  }

  async tabIdOf(_extensionId: string, _path: string, _page: PageId): Promise<number> {
    throw unsupported("tabIdOf", "task.tabs()의 targetId는 라운드 사이에 유지되지 않고 chrome.tabs ID와 같다는 근거도 없습니다");
  }

  async evaluate<T = unknown>(page: PageId, expression: string): Promise<T> {
    return (await this.#onPage(page, `value = await page.evaluate(${JSON.stringify(expression)});`)) as T;
  }

  // finish() closes every page the task space owns and is documented as callable exactly once; user-created tabs are protected.
  async close(): Promise<void> {
    const shotDir = this.#shotDir;
    this.#shotDir = undefined;
    this.#pages.clear();
    try {
      if (this.#spaceId !== undefined && !this.#finished) {
        this.#finished = true;
        await this.#run(`await task.finish({ keep: [] });`);
      }
    } finally {
      if (shotDir) await rm(shotDir, { recursive: true, force: true });
      if (this.#notices.some((line) => line.startsWith(UPDATE_NOTICE))) {
        const first = this.#notices.find((line) => line.startsWith(UPDATE_NOTICE))!;
        this.#write(`ego-browser 알림: ${first.slice(UPDATE_NOTICE.length).trim()} (업그레이드는 하지 않았습니다. 필요하면 직접 'ego-browser upgrade'를 실행하세요)`);
      }
    }
  }

  #known(page: PageId): void {
    if (!this.#pages.has(page)) throw new Error(`unknown page: ${page}`);
  }

  async #onPage(page: PageId, body: string): Promise<unknown> {
    this.#known(page);
    return await this.#run(`const page = task.page(${JSON.stringify(page)});\n${body}`);
  }

  async #run(body: string): Promise<unknown> {
    if (this.#spaceId === undefined) throw new Error("browser not launched");
    return await this.#invoke(`const task = await taskSpace(${this.#spaceId});`, body);
  }

  async #invoke(taskLine: string, body: string): Promise<unknown> {
    const token = randomUUID();
    const script = buildScript(token, taskLine, body);
    const { value, notices } = await this.#spawn(token, script);
    for (const line of notices) {
      this.#notices.push(line);
      this.#log?.line("ego-browser:notice", line, 0);
    }
    return value;
  }

  #spawn(token: string, script: string): Promise<Invocation> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, ["nodejs"], { stdio: ["pipe", "pipe", "pipe"] });
      const resultPrefix = `REEL-RESULT ${token} `;
      const notices: string[] = [];
      let result: { ok: boolean; value?: unknown; error?: string } | undefined;
      let stderr = "";
      let buffered = "";
      let settled = false;

      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(limitTimer);
        outcome();
      };
      const handleLine = (line: string) => {
        if (line.startsWith(resultPrefix)) {
          try {
            result = JSON.parse(line.slice(resultPrefix.length));
          } catch {
            result = { ok: false, error: `결과 줄을 해석하지 못했습니다: ${line.slice(resultPrefix.length, 200)}` };
          }
        } else if (line.startsWith(NOTICE_PREFIX)) {
          notices.push(line);
        }
      };

      const limitTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error(`ego-browser가 ${this.#timeoutMs}ms 안에 응답하지 않아 프로세스를 종료했습니다. ${FAILURE_CAUSES}`)));
      }, this.#timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffered += chunk;
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          handleLine(buffered.slice(0, newline).replace(/\r$/, ""));
          buffered = buffered.slice(newline + 1);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
      });
      child.stdin.on("error", () => undefined);
      child.once("error", (error: NodeJS.ErrnoException) => {
        const reason = error.code === "ENOENT" ? `'${this.#executable}' 실행 파일을 찾지 못했습니다` : message(error);
        finish(() => reject(new Error(`ego-browser를 실행하지 못했습니다: ${reason}`)));
      });
      child.once("close", (code, signal) => {
        if (buffered.length > 0) handleLine(buffered);
        finish(() => {
          if (result?.ok) resolve({ value: result.value, notices });
          else if (result) reject(new Error(result.error ?? "ego-browser 스크립트가 실패했습니다"));
          else {
            const exit = signal ? `신호 ${signal}` : `종료 코드 ${code}`;
            const tail = stderr.trim() ? ` stderr: ${stderr.trim()}` : "";
            reject(new Error(`ego-browser가 결과 없이 끝났습니다 (${exit}).${tail} ${FAILURE_CAUSES}`));
          }
        });
      });
      child.stdin.end(script);
    });
  }
}
