import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXT_NAME = "reel-mesh-spike-ext";

const manifest = {
  manifest_version: 3,
  name: EXT_NAME,
  version: "1.0.0",
  background: { service_worker: "sw.js" },
};

const panelHtml = `<!doctype html><meta charset="utf-8"><body style="background:#123456;margin:0"><h1 id="t" style="color:#fff">panel</h1><script src="panel.js"></script>`;
const panelJs = `const t=document.getElementById("t");let n=0;setInterval(()=>{t.textContent="tick "+(n++)},50);`;

type Mode = "new-headless" | "headed";

async function tryMode(mode: Mode, extDir: string) {
  const profile = await mkdtemp(join(tmpdir(), "reel-spike-profile-"));
  let ctx: BrowserContext | undefined;
  try {
    const args = [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ];
    ctx = await chromium.launchPersistentContext(profile, {
      ...(mode === "new-headless" ? { channel: "chromium" as const, headless: true } : { headless: false }),
      args,
      viewport: { width: 800, height: 500 },
    });
    let [sw] = ctx.serviceWorkers();
    sw ??= await ctx.waitForEvent("serviceworker", { timeout: 8000 });
    const id = new URL(sw.url()).host;

    const target: Page = await ctx.newPage();
    await target.setContent(`<body style="background:#aa3300;margin:0"><h1>target</h1></body>`);
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html?tab=1`);
    await panel.waitForFunction(() => document.getElementById("t")?.textContent !== "panel");

    const shot = async (p: Page) => {
      const buf = await p.screenshot();
      return buf.length;
    };
    const frontBytes = await shot(panel);
    const backBytes = await shot(target);
    const t1 = await target.evaluate(() => performance.now());
    await panel.waitForTimeout(300);
    const t2 = await target.evaluate(() => performance.now());
    const backText = await panel.locator("#t").textContent();
    const backRendered = await target.evaluate(() => getComputedStyle(document.body).backgroundColor);
    return {
      ok: true as const,
      mode,
      extensionId: id,
      frontBytes,
      backBytes,
      backTimerAdvancedMs: Math.round(t2 - t1),
      panelText: backText,
      targetBg: backRendered,
      launchOptions: { channel: mode === "new-headless" ? "chromium" : undefined, headless: mode === "new-headless", args },
    };
  } catch (e) {
    return { ok: false as const, mode, error: String(e instanceof Error ? e.message : e).split("\n")[0] };
  } finally {
    await ctx?.close().catch(() => {});
    await rm(profile, { recursive: true, force: true });
  }
}

const extRoot = await mkdtemp(join(tmpdir(), "reel-spike-ext-"));
try {
  const extDir = join(extRoot, "ext");
  await mkdir(extDir);
  await writeFile(join(extDir, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(extDir, "sw.js"), "self.addEventListener('install',()=>{});");
  await writeFile(join(extDir, "panel.html"), panelHtml);
  await writeFile(join(extDir, "panel.js"), panelJs);

  const results = [];
  for (const mode of ["new-headless", "headed"] as const) {
    const r = await tryMode(mode, extDir);
    results.push(r);
    if (r.ok) break;
  }
  const chosen = results.find((r) => r.ok);
  console.log(JSON.stringify({ chosen: chosen?.mode ?? null, results }));
  process.exitCode = chosen ? 0 : 1;
} finally {
  await rm(extRoot, { recursive: true, force: true });
}
