import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtureServer, writeTempScenario } from "./helpers.ts";
import type { FixtureServer } from "./helpers.ts";
import { TimeoutError, withTimeout } from "../src/runlog.ts";

const bin = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));

interface Result {
  code: number;
  stdout: string;
}

function check(scenario: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [bin, "check", scenario], { cwd, env, timeout: 60000 }, (error, stdout) => {
      const code = error ? ((error as { code?: number }).code ?? -1) : 0;
      resolve({ code, stdout });
    });
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const scenarioFor = (url: string, step = "- click: { screen: page, target: h1 }") => `name: precheck-test
screens:
  - id: page
    url: ${url}
    size: [800, 600]
steps:
  ${step}
`;

describe("check", () => {
  let server: FixtureServer;
  let cwd: string;

  before(async () => {
    server = await startFixtureServer();
    cwd = await mkdtemp(join(tmpdir(), "reel-mesh-check-"));
  });
  after(async () => {
    await server?.stop();
    await rm(cwd, { recursive: true, force: true });
  });

  it("fails fast with server failure and a todo line when nothing listens", async () => {
    const port = await freePort();
    const s = await writeTempScenario(scenarioFor(`http://127.0.0.1:${port}/`));
    try {
      const started = Date.now();
      const r = await check(s.path, cwd);
      assert.equal(r.code, 3);
      assert.ok(Date.now() - started < 30000);
      assert.match(r.stdout, /^FAIL 개발 서버: .*127\.0\.0\.1/m);
      assert.match(r.stdout, /^할 일: .+/m);
      assert.match(r.stdout, /^skip 브라우저 실행/m);
      assert.match(r.stdout, /^skip 첫 대상 요소/m);
      assert.match(await readFile(join(cwd, ".reel", "precheck-test", "run.log"), "utf8"), /\tcheck:개발 서버\tfail /);
    } finally {
      await s.cleanup();
    }
  });

  it("reports ffmpeg failure when ffmpeg is missing from PATH", async () => {
    const s = await writeTempScenario(scenarioFor(server.url));
    try {
      const r = await check(s.path, cwd, { ...process.env, PATH: cwd });
      assert.equal(r.code, 3);
      assert.match(r.stdout, /^FAIL ffmpeg: /m);
      assert.match(r.stdout, /^할 일: .+ffmpeg/m);
    } finally {
      await s.cleanup();
    }
  });

  it("passes with exit 0 when the server and first target exist", async () => {
    const s = await writeTempScenario(scenarioFor(server.url));
    try {
      const r = await check(s.path, cwd);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /^ok 첫 대상 요소/m);
      assert.match(r.stdout, /^skip 확장: 시나리오에 확장 화면이 없습니다/m);
    } finally {
      await s.cleanup();
    }
  });

  it("fails when the first target is missing", async () => {
    const s = await writeTempScenario(scenarioFor(server.url, "- click: { screen: page, target: '#nope' }"));
    try {
      const r = await check(s.path, cwd);
      assert.equal(r.code, 3);
      assert.match(r.stdout, /^FAIL 첫 대상 요소: .*0개/m);
    } finally {
      await s.cleanup();
    }
  });

  it("resolves text, shadow and frame targets", async () => {
    for (const target of [
      "{ text: Click me }",
      "{ shadow: ['#shadow-host', button] }",
      "{ frame: '#frame', target: '#frame-button' }",
    ]) {
      const s = await writeTempScenario(scenarioFor(server.url, `- click: { screen: page, target: ${target} }`));
      try {
        const r = await check(s.path, cwd);
        assert.equal(r.code, 0, `${target}\n${r.stdout}`);
      } finally {
        await s.cleanup();
      }
    }
  });
});

describe("withTimeout", () => {
  it("rejects with the label when work does not finish", async () => {
    await assert.rejects(withTimeout("slow", 20, new Promise(() => {})), (e: unknown) => e instanceof TimeoutError && /slow/.test(e.message));
  });
  it("returns the result when work finishes in time", async () => {
    assert.equal(await withTimeout("fast", 1000, async () => 7), 7);
  });
});
