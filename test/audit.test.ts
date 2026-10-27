import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { startFixtureServer } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { PlaywrightAdapter } from "../src/browser/playwright.ts";
import { recordScenario } from "../src/recorder.ts";
import type { RecordResult } from "../src/recorder.ts";
import { loadScenario } from "../src/scenario.ts";
import { openRunLog } from "../src/runlog.ts";
import { MASK_COLOR } from "../src/overlay.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const SECRET = "secret-value-xyz";
const OTHER = "other-token-123";
const AREA_A = { left: 100, top: 300, width: 200, height: 40 };
const AREA_B = { left: 100, top: 420, width: 200, height: 40 };

interface Png {
  width: number;
  channels: number;
  data: Buffer;
}

function decodePng(buffer: Buffer): Png {
  assert.equal(buffer.readUInt8(24), 8, "8-bit PNG expected");
  assert.equal(buffer.readUInt8(28), 0, "non-interlaced PNG expected");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const channels = buffer.readUInt8(25) === 6 ? 4 : 3;
  const chunks: Buffer[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    if (buffer.toString("ascii", at + 4, at + 8) === "IDAT") chunks.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= channels ? data[y * stride + x - channels]! : 0;
      const up = y > 0 ? data[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels]! : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + x] = (cur + predicted) & 0xff;
    }
  }
  return { width, channels, data };
}

function pixelsIn(png: Png, area: typeof AREA_A, inset = 4): Set<string> {
  const colors = new Set<string>();
  for (let y = area.top + inset; y < area.top + area.height - inset; y++) {
    for (let x = area.left + inset; x < area.left + area.width - inset; x++) {
      const at = (y * png.width + x) * png.channels;
      colors.add(`#${[0, 1, 2].map((c) => png.data[at + c]!.toString(16).padStart(2, "0")).join("")}`);
    }
  }
  return colors;
}

const place = (area: typeof AREA_A) =>
  `Object.assign(el.style, { position: "absolute", left: "${area.left}px", top: "${area.top}px", width: "${area.width}px", height: "${area.height}px" })`;

const SHOW_EMAIL = `export default async function (ctx) {
  await ctx.evaluate("page", () => {
    const el = document.createElement("div");
    el.id = "user-email";
    el.textContent = "${SECRET}";
    el.style.cssText = "background:#ff00ff;color:#fff;font:16px sans-serif";
    ${place(AREA_A)};
    document.body.append(el);
  });
}
`;

const MOVE_EMAIL = `export default async function (ctx) {
  await ctx.evaluate("page", () => {
    const el = document.getElementById("user-email");
    ${place(AREA_B)};
  });
}
`;

const scenarioText = (name: string, url: string, mask: string) => `name: ${name}
screens:
  - id: page
    url: ${url}
    size: [800, 600]
${mask}timing: { stepTimeoutMs: 2000, pointerSteps: 4, pointerStepMs: 20, frameMs: 100 }
steps:
  - script: show.js
  - script: move.js
`;

interface Cli {
  code: number;
  stdout: string;
}

function cli(args: string[], cwd: string): Promise<Cli> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, ...args], { cwd, timeout: 60000 }, (error, stdout) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stdout });
    });
  });
}

describe("mask and audit", () => {
  let server: FixtureServer;
  let dir: string;
  let runs = 0;

  before(async () => {
    server = await startFixtureServer();
    dir = await mkdtemp(join(tmpdir(), "reel-mesh-audit-"));
  });
  after(async () => {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function record(name: string, mask: string): Promise<{ scenarioFile: string; base: string; result: RecordResult; out: string[]; overlayLeft: boolean }> {
    const sub = join(dir, `s${runs++}`);
    await mkdir(sub, { recursive: true });
    await writeFile(join(sub, "show.js"), SHOW_EMAIL);
    await writeFile(join(sub, "move.js"), MOVE_EMAIL);
    const scenarioFile = join(sub, "scenario.yaml");
    await writeFile(scenarioFile, scenarioText(name, server.url, mask));
    const base = join(sub, "out");
    const scenario = loadScenario(scenarioFile);
    const adapter = new PlaywrightAdapter();
    await adapter.launch();
    try {
      const out: string[] = [];
      const result = await recordScenario(scenario, adapter, openRunLog(name, base), (line) => out.push(line));
      const page = result.pages.get("page")!;
      const overlayLeft = await adapter.evaluate<boolean>(page, `document.querySelector("[data-reel-overlay]") !== null`);
      return { scenarioFile, base, result, out, overlayLeft };
    } finally {
      await adapter.close();
    }
  }

  async function lastFrame(base: string, name: string, index: number): Promise<Png> {
    const frames = JSON.parse(await readFile(join(base, ".reel", name, "frames.json"), "utf8")) as { screens: Record<string, string> }[];
    return decodePng(await readFile(join(base, ".reel", name, frames[index]!.screens.page!)));
  }

  it("paints an opaque box over the masked element, follows it after a layout change, and warns about a selector that never matched", async () => {
    const masked = await record("masked", `mask: ["#user-email", "#never-there"]\n`);
    assert.equal(masked.result.code, 0, masked.out.join("\n"));
    assert.equal(masked.overlayLeft, false);
    assert.equal(masked.result.frames.length, 2);

    const first = await lastFrame(masked.base, "masked", 0);
    assert.deepEqual([...pixelsIn(first, AREA_A)], [MASK_COLOR]);
    const second = await lastFrame(masked.base, "masked", 1);
    assert.deepEqual([...pixelsIn(second, AREA_B)], [MASK_COLOR]);
    assert.notDeepEqual([...pixelsIn(second, AREA_A)], [MASK_COLOR], "old position must be uncovered after the element moved");

    assert.ok(masked.out.some((l) => l.startsWith("WARN mask '#never-there'")), masked.out.join("\n"));
    assert.ok(!masked.out.some((l) => l.includes("#user-email") && l.startsWith("WARN")));
    assert.match(await readFile(join(masked.base, ".reel", "masked", "run.log"), "utf8"), /mask\twarn no match #never-there/);

    const open = await record("unmasked", "");
    assert.equal(open.result.code, 0, open.out.join("\n"));
    const visible = await lastFrame(open.base, "unmasked", 0);
    assert.ok(pixelsIn(visible, AREA_A).size > 1 && !pixelsIn(visible, AREA_A).has(MASK_COLOR), "without mask the area keeps its own colors");
  });

  it("finds denied strings in scenario scripts and run.log, prints only masked prefixes, and skips images", async () => {
    const run = await record("audited", `mask: ["#user-email"]\n`);
    assert.equal(run.result.code, 0, run.out.join("\n"));
    appendFileSync(join(run.base, ".reel", "audited", "run.log"), `leak ${OTHER}\n`);
    const deny = join(run.base, "deny.txt");
    await writeFile(deny, `${SECRET}\n\n${OTHER}\nnever-present-zzz\n`);

    const found = await cli(["audit", run.scenarioFile, "--deny-file", deny], run.base);
    assert.equal(found.code, 6, found.stdout);
    assert.match(found.stdout, /show\.js:\d+ 금지 문자열 1번 항목 \(se\*\*\*\)/);
    assert.match(found.stdout, /\.reel\/audited\/run\.log:\d+ 금지 문자열 2번 항목 \(ot\*\*\*\)/);
    assert.doesNotMatch(found.stdout, /never-present|금지 문자열 3번/);
    assert.match(found.stdout, /이미지 속 글자는 검사하지 않습니다/);
    assert.ok(!found.stdout.includes(SECRET) && !found.stdout.includes(OTHER), "full denied values must not be printed");
    assert.doesNotMatch(found.stdout, /\.png/);

    const cleanDeny = join(run.base, "clean-deny.txt");
    await writeFile(cleanDeny, "never-present-zzz\nanother-absent-value\n");
    const clean = await cli(["audit", run.scenarioFile, "--deny-file", cleanDeny], run.base);
    assert.equal(clean.code, 0, clean.stdout);
    assert.match(clean.stdout, /금지 문자열 없음/);
  });

  it("rejects missing arguments and an unreadable or empty deny file with exit 2", async () => {
    const empty = join(dir, "empty-deny.txt");
    await writeFile(empty, "\n\n");
    const scenario = join(dir, "s0", "scenario.yaml");
    assert.equal((await cli(["audit", scenario], dir)).code, 2);
    assert.equal((await cli(["audit", scenario, "--deny-file", join(dir, "absent.txt")], dir)).code, 2);
    assert.equal((await cli(["audit", scenario, "--deny-file", empty], dir)).code, 2);
  });
});
