import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeStill, workspaceOf } from "../src/compose.ts";
import type { FrameRecord } from "../src/recorder.ts";
import { loadScenario } from "../src/scenario.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
const FRAME_SECONDS = 1 / 15;
const DURATIONS = [500, 300, 700];
const SIZES = { a: [100, 80], b: [60, 50] } as const;
const COLORS = ["red", "blue", "green"];

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: 90000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? -1) : 0, stdout, stderr });
    });
  });
}

const cli = (args: string[], cwd: string): Promise<Cli> => run(process.execPath, [bin, ...args], cwd);

async function probe(path: string, entries: string): Promise<Record<string, string>> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", entries, "-of", "default=nw=1", path], process.cwd());
  return Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=") as [string, string]));
}

async function colorPng(path: string, color: string, size: readonly [number, number]): Promise<void> {
  const r = await run("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size[0]}x${size[1]}`, "-frames:v", "1", path], process.cwd());
  assert.equal(r.code, 0, r.stderr);
}

const scenarioText = (direction: string) => `name: compose
screens:
  - id: a
    url: http://127.0.0.1:1/
    size: [100, 80]
  - id: b
    url: http://127.0.0.1:1/
    size: [60, 50]
layout: { direction: ${direction}, border: 2 }
steps:
  - wait: 100
`;

describe("compose, review, render", () => {
  let cwd: string;
  let frames: FrameRecord[];

  before(async () => {
    cwd = await mkdtemp(join(tmpdir(), "reel-mesh-compose-"));
    const dir = join(cwd, ".reel", "compose");
    await mkdir(join(dir, "frames"), { recursive: true });
    frames = [];
    for (const [i, durationMs] of DURATIONS.entries()) {
      const screens: Record<string, string> = {};
      for (const id of ["a", "b"] as const) {
        screens[id] = `frames/${String(i).padStart(4, "0")}-${id}.png`;
        await colorPng(join(dir, screens[id]), COLORS[i]!, SIZES[id]);
      }
      frames.push({ index: i, step: i < 2 ? 1 : 2, durationMs, screens });
    }
    await writeFile(join(dir, "frames.json"), JSON.stringify(frames));
    await writeFile(join(cwd, "horizontal.yaml"), scenarioText("horizontal"));
    await writeFile(join(cwd, "vertical.yaml"), scenarioText("vertical"));
  });
  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("joins two screens as w1 + border + w2, padding the shorter one", async () => {
    const scenario = loadScenario(join(cwd, "horizontal.yaml"));
    const out = join(cwd, "still-h.png");
    const size = await composeStill(scenario, workspaceOf(scenario, cwd), frames[0]!, out);
    assert.deepEqual(size, { width: 100 + 2 + 60, height: 80 });
    const probed = await probe(out, "stream=width,height");
    assert.equal(Number(probed.width), 162);
    assert.equal(Number(probed.height), 80);
  });

  it("joins two screens as h1 + border + h2 in a vertical layout", async () => {
    const scenario = loadScenario(join(cwd, "vertical.yaml"));
    const out = join(cwd, "still-v.png");
    await composeStill(scenario, workspaceOf(scenario, cwd), frames[0]!, out);
    const probed = await probe(out, "stream=width,height");
    assert.equal(Number(probed.width), 100);
    assert.equal(Number(probed.height), 80 + 2 + 50);
  });

  it("review writes a contact sheet and the last frame of every step", async () => {
    const r = await cli(["review", join(cwd, "horizontal.yaml")], cwd);
    assert.equal(r.code, 0, r.stderr);
    const review = join(cwd, ".reel", "compose", "review");
    for (const name of ["contact-sheet.png", "step-1.png", "step-2.png"]) assert.ok(existsSync(join(review, name)), name);
  });

  it("render makes a GIF whose length matches the summed durations and no MP4 by default", async () => {
    const r = await cli(["render", join(cwd, "horizontal.yaml")], cwd);
    assert.equal(r.code, 0, r.stderr);
    const gif = join(cwd, ".reel", "compose", "compose.gif");
    const probed = await probe(gif, "format=duration:stream=width");
    const expected = DURATIONS.reduce((a, b) => a + b, 0) / 1000;
    assert.ok(Math.abs(Number(probed.duration) - expected) <= FRAME_SECONDS, `${probed.duration} vs ${expected}`);
    assert.equal(Number(probed.width), 162);
    assert.ok(!existsSync(`${gif}.tmp`));
    assert.doesNotMatch(r.stdout, /mp4/);
  });

  it("render --mp4 writes the MP4 to the given path", async () => {
    const mp4 = join(cwd, "out", "compose.mp4");
    const r = await cli(["render", join(cwd, "horizontal.yaml"), "--mp4", mp4], cwd);
    assert.equal(r.code, 0, r.stderr);
    const probed = await probe(mp4, "format=duration");
    assert.ok(Math.abs(Number(probed.duration) - 1.5) <= FRAME_SECONDS);
  });

  it("render suggests a smaller command when over the budget", async () => {
    const r = await cli(["render", join(cwd, "horizontal.yaml"), "--budget-mb", "0.0001"], cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /WARN render:/);
    assert.match(r.stdout, /render .*horizontal\.yaml --width \d+ --colors \d+ --budget-mb/);
  });

  it("render fails with exit 1 and leaves no GIF when a frame is broken", async () => {
    const broken = await mkdtemp(join(tmpdir(), "reel-mesh-compose-broken-"));
    try {
      const dir = join(broken, ".reel", "compose");
      await mkdir(join(dir, "frames"), { recursive: true });
      await writeFile(join(dir, "frames", "x.png"), "not a png at all, just text");
      const bad = frames.map((f) => ({ ...f, screens: { a: "frames/x.png", b: "frames/x.png" } }));
      await writeFile(join(dir, "frames.json"), JSON.stringify(bad));
      const r = await cli(["render", join(cwd, "horizontal.yaml")], broken);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /FAIL render:/);
      assert.match(r.stderr, /log: .*ffmpeg\.log/);
      assert.ok(!existsSync(join(dir, "compose.gif")));
      assert.ok(!existsSync(join(dir, "compose.gif.tmp")));
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it("render fails with exit 1 when ffmpeg rejects the input", async () => {
    const broken = await mkdtemp(join(tmpdir(), "reel-mesh-compose-ffmpeg-"));
    try {
      const dir = join(broken, ".reel", "compose");
      await mkdir(join(dir, "frames"), { recursive: true });
      const header = Buffer.from("89504e470d0a1a0a0000000d49484452000000640000005000000000", "hex");
      await writeFile(join(dir, "frames", "x.png"), header);
      const bad = frames.map((f) => ({ ...f, screens: { a: "frames/x.png", b: "frames/x.png" } }));
      await writeFile(join(dir, "frames.json"), JSON.stringify(bad));
      const r = await cli(["render", join(cwd, "horizontal.yaml")], broken);
      assert.equal(r.code, 1);
      assert.match(r.stderr, /FAIL render: ffmpeg 실패/);
      assert.match(r.stderr, /명령: ffmpeg/);
      assert.ok(existsSync(join(dir, "ffmpeg.log")));
      assert.ok(!existsSync(join(dir, "compose.gif")));
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });
});
