import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";

const exists = (path: string) => access(path).then(() => true, () => false);

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("PlaywrightAdapter", () => {
  let server: FixtureServer;

  before(async () => {
    server = await startFixtureServer();
  });
  after(async () => {
    await server?.stop();
  });

  it("captures a PNG at the fixed viewport size", async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.launch();
      const page = await adapter.openPage();
      await adapter.goto(page, server.url);
      await adapter.setViewport(page, 800, 600);
      assert.deepEqual(pngSize(await adapter.screenshot(page)), { width: 800, height: 600 });
    } finally {
      await adapter.close();
    }
  });

  it("records dblclick as click details 1 then 2", async () => {
    const adapter = new PlaywrightAdapter();
    try {
      await adapter.launch();
      const page = await adapter.openPage();
      await adapter.goto(page, server.url);
      await adapter.setViewport(page, 800, 600);
      const box = await adapter.evaluate<{ x: number; y: number }>(
        page,
        `(() => { const r = document.getElementById("main-button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      await adapter.mouseClick(page, box.x, box.y, 1);
      await adapter.mouseClick(page, box.x, box.y, 2);
      assert.deepEqual(await adapter.evaluate(page, "window.__clickDetails"), [1, 2]);
    } finally {
      await adapter.close();
    }
  });

  it("removes the temporary profile after close", async () => {
    const adapter = new PlaywrightAdapter();
    await adapter.launch();
    const dir = adapter.profileDir!;
    assert.equal(await exists(dir), true);
    await adapter.close();
    assert.equal(await exists(dir), false);
  });

  it("removes the temporary profile when an operation throws", async () => {
    const adapter = new PlaywrightAdapter();
    let dir: string | undefined;
    try {
      await adapter.launch();
      dir = adapter.profileDir;
      const page = await adapter.openPage();
      await assert.rejects(adapter.goto(page, "http://127.0.0.1:1/"));
      await adapter.evaluate(page, "throw new Error('boom')");
    } catch {
    } finally {
      await adapter.close();
    }
    assert.ok(dir);
    assert.equal(await exists(dir), false);
  });
});
