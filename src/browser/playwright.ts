import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserAdapter, LaunchOptions, MouseButton, PageId } from "./adapter.ts";

const BACKGROUND_THROTTLING_OFF = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
];

const EXTENSION_WAIT_MS = 5000;
const EXTENSION_POLL_MS = 100;

export class PlaywrightAdapter implements BrowserAdapter {
  readonly name = "playwright";
  profileDir: string | undefined;
  #context: BrowserContext | undefined;
  #pages = new Map<PageId, Page>();
  #nextId = 1;

  async launch(options: LaunchOptions = {}): Promise<void> {
    if (this.#context) throw new Error("already launched");
    const extensionPaths = options.extensionPaths ?? [];
    // Extensions load only at launch and only in new headless (docs/spike-notes.md); the mode is never switched mid-run.
    const extensionArgs =
      extensionPaths.length === 0 ? [] : [`--disable-extensions-except=${extensionPaths.join(",")}`, `--load-extension=${extensionPaths.join(",")}`];
    const profileDir = await mkdtemp(join(tmpdir(), "reel-mesh-profile-"));
    this.profileDir = profileDir;
    try {
      this.#context = await chromium.launchPersistentContext(profileDir, {
        channel: "chromium",
        headless: true,
        args: [...extensionArgs, ...BACKGROUND_THROTTLING_OFF],
      });
    } catch (error) {
      await rm(profileDir, { recursive: true, force: true });
      throw error;
    }
  }

  async openPage(): Promise<PageId> {
    const page = await this.#ctx().newPage();
    const id = `page-${this.#nextId++}`;
    this.#pages.set(id, page);
    return id;
  }

  async closePage(id: PageId): Promise<void> {
    const page = this.#page(id);
    this.#pages.delete(id);
    await page.close();
  }

  async goto(id: PageId, url: string): Promise<void> {
    await this.#page(id).goto(url);
  }

  async setViewport(id: PageId, width: number, height: number, scale = 1): Promise<void> {
    const page = this.#page(id);
    await page.setViewportSize({ width, height });
    if (scale !== 1) {
      const session = await this.#ctx().newCDPSession(page);
      await session.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: scale,
        mobile: false,
      });
    }
  }

  async screenshot(id: PageId): Promise<Uint8Array> {
    return await this.#page(id).screenshot({ type: "png" });
  }

  async mouseMove(id: PageId, x: number, y: number): Promise<void> {
    await this.#page(id).mouse.move(x, y);
  }

  async mouseDown(id: PageId, button: MouseButton = "left"): Promise<void> {
    await this.#page(id).mouse.down({ button });
  }

  async mouseUp(id: PageId, button: MouseButton = "left"): Promise<void> {
    await this.#page(id).mouse.up({ button });
  }

  // Playwright's mouse.click({clickCount: n}) emits presses 1..n, so a single press with the given count is sent instead.
  async mouseClick(id: PageId, x: number, y: number, clickCount = 1): Promise<void> {
    const mouse = this.#page(id).mouse;
    await mouse.move(x, y);
    await mouse.down({ clickCount });
    await mouse.up({ clickCount });
  }

  async keyboardType(id: PageId, text: string): Promise<void> {
    await this.#page(id).keyboard.type(text);
  }

  async keyboardPress(id: PageId, key: string): Promise<void> {
    await this.#page(id).keyboard.press(key);
  }

  async findExtensionId(name: string): Promise<string | null> {
    const deadline = Date.now() + EXTENSION_WAIT_MS;
    for (;;) {
      for (const worker of this.#ctx().serviceWorkers()) {
        if (!worker.url().startsWith("chrome-extension://")) continue;
        const manifestName = await worker.evaluate("chrome.runtime.getManifest().name").catch(() => null);
        if (manifestName === name) return new URL(worker.url()).host;
      }
      if (Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => setTimeout(resolve, EXTENSION_POLL_MS));
    }
  }

  async tabIdOf(extensionId: string, path: string, target: PageId): Promise<number> {
    const url = this.#page(target).url();
    const helper = await this.#ctx().newPage();
    try {
      await helper.goto(`chrome-extension://${extensionId}/${path}`);
      const ids = await helper.evaluate(
        `chrome.tabs.query({}).then((tabs) => tabs.filter((t) => t.url === ${JSON.stringify(url)}).map((t) => t.id))`,
      );
      if (!Array.isArray(ids) || ids.length !== 1) {
        throw new Error(`${url}에 해당하는 탭이 ${Array.isArray(ids) ? ids.length : 0}개입니다 (1개여야 합니다. 확장에 tabs 권한이 필요합니다)`);
      }
      return ids[0] as number;
    } finally {
      await helper.close().catch(() => undefined);
    }
  }

  async openExtensionPage(extensionId: string, path: string, pinTo: PageId | null): Promise<PageId> {
    const query = pinTo === null ? "" : `?tab=${await this.tabIdOf(extensionId, path, pinTo)}`;
    const id = await this.openPage();
    try {
      await this.goto(id, `chrome-extension://${extensionId}/${path}${query}`);
    } catch (error) {
      await this.closePage(id).catch(() => undefined);
      throw error;
    }
    return id;
  }

  async evaluate<T = unknown>(id: PageId, expression: string): Promise<T> {
    return (await this.#page(id).evaluate(expression)) as T;
  }

  async close(): Promise<void> {
    const context = this.#context;
    const profileDir = this.profileDir;
    this.#context = undefined;
    this.#pages.clear();
    try {
      await context?.close();
    } finally {
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    }
  }

  #ctx(): BrowserContext {
    if (!this.#context) throw new Error("browser not launched");
    return this.#context;
  }

  #page(id: PageId): Page {
    const page = this.#pages.get(id);
    if (!page) throw new Error(`unknown page: ${id}`);
    return page;
  }
}
