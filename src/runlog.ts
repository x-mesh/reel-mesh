import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface RunLog {
  path: string;
  line(step: string, event: string, frames: number): void;
}

export class TimeoutError extends Error {
  readonly label: string;
  readonly ms: number;
  constructor(label: string, ms: number) {
    super(`${label}: no result within ${ms}ms`);
    this.label = label;
    this.ms = ms;
  }
}

// appendFileSync writes each line immediately, so the log survives a hang or kill mid-run (F1).
export function openRunLog(name: string, baseDir: string = process.cwd()): RunLog {
  const dir = join(baseDir, ".reel", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run.log");
  return {
    path,
    line(step, event, frames) {
      appendFileSync(path, `${new Date().toISOString()}\t${step}\t${event}\t${frames}\n`);
    },
  };
}

export async function withTimeout<T>(label: string, ms: number, work: Promise<T> | (() => Promise<T>)): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([typeof work === "function" ? work() : work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

// Commands printed for the user must work from the target project, where a relative bin/ path does not exist.
export const CLI_PATH = fileURLToPath(new URL("../bin/reel-mesh.ts", import.meta.url));
