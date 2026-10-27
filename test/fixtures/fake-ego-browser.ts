#!/usr/bin/env node
// Stand-in for `ego-browser nodejs` used by tests. It never touches a real browser: taskSpace and Page are
// recorders whose calls land in $FAKE_EGO_DIR/calls.jsonl. Behavior is chosen by $FAKE_EGO_DIR/mode (ok|die|hang).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const dir = process.env.FAKE_EGO_DIR ?? "";
if (process.argv[2] !== "nodejs" || dir === "") {
  console.error("fake-ego-browser: usage: FAKE_EGO_DIR=<dir> fake-ego-browser nodejs < script");
  process.exit(64);
}

interface Space {
  name: string;
  pages: string[];
  nextPage: number;
  finished: boolean;
}
interface State {
  nextSpace: number;
  spaces: Record<string, Space>;
}

const statePath = join(dir, "state.json");
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { nextSpace: 1, spaces: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const mode = existsSync(join(dir, "mode")) ? readFileSync(join(dir, "mode"), "utf8").trim() : "ok";
const record = (call: string, detail: Record<string, unknown>) => appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify({ pid: process.pid, call, ...detail })}\n`);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function pageHandle(spaceId: number, space: Space, label: string) {
  const call = (name: string, detail: Record<string, unknown> = {}) => {
    if (space.finished) throw new Error(`space ${spaceId} already finished`);
    if (!space.pages.includes(label)) throw new Error(`no such page ${label}`);
    record(name, { space: spaceId, page: label, ...detail });
  };
  return {
    label,
    goto: async (url: string) => call("page.goto", { url }),
    cdp: async (method: string, params: unknown) => call("page.cdp", { method, params }),
    evaluate: async (expression: string) => {
      call("page.evaluate", { expression });
      const path = join(dir, "evaluate.json");
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    },
    screenshot: async (options: { path: string }) => {
      call("page.screenshot", { path: options.path });
      writeFileSync(options.path, PNG);
      return options.path;
    },
    close: async () => {
      call("page.close");
      space.pages = space.pages.filter((p) => p !== label);
      save();
    },
    mouse: {
      move: async (x: number, y: number) => call("mouse.move", { x, y }),
      click: async (x: number, y: number) => call("mouse.click", { x, y }),
      down: async () => call("mouse.down"),
      up: async () => call("mouse.up"),
    },
    keyboard: {
      type: async (text: string) => call("keyboard.type", { text }),
      press: async (key: string) => call("keyboard.press", { key }),
    },
  };
}

async function taskSpace(nameOrId: string | number) {
  let id: number;
  if (typeof nameOrId === "number") {
    id = nameOrId;
    if (!state.spaces[id]) throw new Error(`no task space ${id}`);
  } else {
    const existing = Object.entries(state.spaces).find(([, s]) => s.name === nameOrId);
    if (existing) id = Number(existing[0]);
    else {
      id = state.nextSpace++;
      state.spaces[id] = { name: nameOrId, pages: ["p1"], nextPage: 2, finished: false };
      save();
    }
  }
  const space = state.spaces[id]!;
  record("taskSpace", { space: id, argument: nameOrId });
  return {
    spaceId: id,
    page: (label: string) => pageHandle(id, space, label),
    newPage: async () => {
      const label = `p${space.nextPage++}`;
      space.pages.push(label);
      save();
      record("task.newPage", { space: id, page: label });
      return pageHandle(id, space, label);
    },
    finish: async (options: { keep: string[] }) => {
      if (space.finished) throw new Error(`space ${id} already finished`);
      space.finished = true;
      save();
      record("task.finish", { space: id, keep: options.keep });
    },
  };
}

const script = await readStdin();
console.log("[ego-browser:notice] Ego Lite 2.9.9 is available");
console.log("plain noise line that is not a result");

if (mode === "die") {
  console.error("browser control was taken by the user");
  process.exit(3);
}
if (mode === "hang") {
  record("hang", {});
  setInterval(() => undefined, 1000);
} else {
  console.log('REEL-RESULT not-the-real-token {"ok":true,"value":"spoofed"}');
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<void>;
  await new AsyncFunction("taskSpace", "console", script)(taskSpace, console);
  console.log("[ego-browser:notice] trailing notice after the result");
}
