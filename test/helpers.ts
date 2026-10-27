import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serveScript = fileURLToPath(new URL("../examples/fixture-app/serve.ts", import.meta.url));

export interface FixtureServer {
  url: string;
  stop(): Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const child = spawn(process.execPath, [serveScript, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = "";
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        const line = buffered.split("\n")[0];
        if (buffered.includes("\n")) resolve(Number(line));
      });
      child.once("exit", (code) => reject(new Error(`fixture server exited early: ${code}`)));
    });
    return { url: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export interface TempScenario {
  path: string;
  cleanup(): Promise<void>;
}

export async function writeTempScenario(content: string, name = "scenario.yaml"): Promise<TempScenario> {
  const dir = await mkdtemp(join(tmpdir(), "reel-mesh-scenario-"));
  const path = join(dir, name);
  await writeFile(path, content);
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
