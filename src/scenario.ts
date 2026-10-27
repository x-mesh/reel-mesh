import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

export type Target =
  | { kind: "css"; selector: string }
  | { kind: "text"; text: string }
  | { kind: "shadow"; host: string; inner: string }
  | { kind: "frame"; frame: string; target: Target };

export type Action =
  | { kind: "goto"; screen: string; url: string }
  | { kind: "click"; screen: string; target: Target }
  | { kind: "dblclick"; screen: string; target: Target }
  | { kind: "drag"; screen: string; from: Target; to: Target }
  | { kind: "type"; screen: string; target: Target; text: string }
  | { kind: "press"; screen: string; key: string }
  | { kind: "wait"; ms: number }
  | { kind: "caption"; text: string }
  | { kind: "screen"; screen: string }
  | { kind: "expect"; screen: string; selector: string }
  | { kind: "script"; path: string };

export interface Expectation {
  screen: string;
  selector: string;
}

export interface Step {
  action: Action;
  expect: Expectation | null;
  retry: number;
}

export interface Extension {
  name: string;
  path: string;
  page: string;
  pinTo: string | null;
}

export interface Screen {
  id: string;
  url: string | null;
  extension: Extension | null;
  width: number;
  height: number;
  scale: number;
}

export interface Scenario {
  file: string;
  name: string;
  caption: { lang: string; position: Record<string, "top" | "bottom"> };
  screens: Screen[];
  layout: { direction: "horizontal" | "vertical"; border: number };
  state: {
    localStorage: string[];
    chromeStorage: string[];
    restoreViaBlankOrigin: boolean;
    blankPath: string | null;
  };
  mask: string[];
  timing: {
    stepTimeoutMs: number;
    pointerSteps: number;
    pointerStepMs: number;
    frameMs: number;
    contactSheetIntervalMs: number;
  };
  steps: Step[];
}

export class ScenarioError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors.join("\n"));
    this.errors = errors;
  }
}

const DEFAULT_FRAME_MS = 100;
const ACTION_KEYS = ["goto", "click", "dblclick", "drag", "type", "press", "wait", "caption", "screen", "expect", "script"];

type Obj = Record<string, unknown>;

class Checker {
  readonly errors: string[] = [];

  fail(path: string, reason: string): void {
    this.errors.push(`${path}: ${reason}`);
  }

  obj(value: unknown, path: string): Obj | null {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Obj;
    this.fail(path, "must be a mapping");
    return null;
  }

  keys(o: Obj, path: string, allowed: string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, "unknown key");
  }

  str(v: unknown, path: string): string | null {
    if (v === undefined) return this.fail(path, "required"), null;
    if (typeof v !== "string" || v === "") return this.fail(path, "must be a non-empty string"), null;
    return v;
  }

  strOr(v: unknown, path: string, fallback: string): string {
    return v === undefined ? fallback : (this.str(v, path) ?? fallback);
  }

  num(v: unknown, path: string, fallback: number, min: number, integer: boolean): number {
    if (v === undefined) return fallback;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      this.fail(path, `must be ${integer ? "an integer" : "a number"} >= ${min}`);
      return fallback;
    }
    return v;
  }

  strList(v: unknown, path: string): string[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return this.fail(path, "must be a list of strings"), [];
    const out: string[] = [];
    v.forEach((item, i) => {
      const s = this.str(item, `${path}[${i}]`);
      if (s !== null) out.push(s);
    });
    return out;
  }

  oneOf<T extends string>(v: unknown, path: string, options: readonly T[], fallback: T): T {
    if (v === undefined) return fallback;
    if (typeof v === "string" && (options as readonly string[]).includes(v)) return v as T;
    this.fail(path, `must be one of ${options.join(", ")}`);
    return fallback;
  }
}

function target(c: Checker, v: unknown, path: string): Target | null {
  if (v === undefined) return c.fail(path, "required"), null;
  if (typeof v === "string") {
    return v === "" ? (c.fail(path, "must be a non-empty string"), null) : { kind: "css", selector: v };
  }
  const o = c.obj(v, path);
  if (!o) return null;
  if ("frame" in o) {
    c.keys(o, path, ["frame", "target"]);
    const frame = c.str(o.frame, `${path}.frame`);
    const inner = target(c, o.target, `${path}.target`);
    return frame === null || inner === null ? null : { kind: "frame", frame, target: inner };
  }
  const keys = Object.keys(o);
  if (keys.length !== 1) return c.fail(path, "must have exactly one of text, shadow, frame"), null;
  if ("text" in o) {
    const text = c.str(o.text, `${path}.text`);
    return text === null ? null : { kind: "text", text };
  }
  if ("shadow" in o) {
    const pair = o.shadow;
    if (!Array.isArray(pair) || pair.length !== 2 || pair.some((x) => typeof x !== "string" || x === "")) {
      return c.fail(`${path}.shadow`, "must be [host, inner] selectors"), null;
    }
    return { kind: "shadow", host: pair[0] as string, inner: pair[1] as string };
  }
  c.fail(`${path}.${keys[0]}`, "unknown key");
  return null;
}

function parseScreens(c: Checker, v: unknown): Screen[] {
  if (!Array.isArray(v) || v.length === 0) return c.fail("screens", "required: non-empty list"), [];
  const screens: Screen[] = [];
  const seen = new Set<string>();
  v.forEach((raw, i) => {
    const path = `screens[${i}]`;
    const o = c.obj(raw, path);
    if (!o) return;
    c.keys(o, path, ["id", "url", "extension", "size", "scale"]);
    const id = c.str(o.id, `${path}.id`);
    if (id !== null) {
      if (seen.has(id)) c.fail(`${path}.id`, `duplicate screen id "${id}"`);
      seen.add(id);
    }
    const hasUrl = o.url !== undefined;
    const hasExt = o.extension !== undefined;
    if (hasUrl === hasExt) c.fail(path, "exactly one of url, extension is required");
    const url = hasUrl ? c.str(o.url, `${path}.url`) : null;
    let extension: Extension | null = null;
    if (hasExt) {
      const e = c.obj(o.extension, `${path}.extension`);
      if (e) {
        c.keys(e, `${path}.extension`, ["name", "path", "page", "pinTo"]);
        const name = c.str(e.name, `${path}.extension.name`);
        const extPath = c.str(e.path, `${path}.extension.path`);
        const page = c.strOr(e.page, `${path}.extension.page`, "panel.html");
        const pinTo = e.pinTo === undefined ? null : c.str(e.pinTo, `${path}.extension.pinTo`);
        if (name !== null && extPath !== null) extension = { name, path: extPath, page, pinTo };
      }
    }
    let width = 0;
    let height = 0;
    const size = o.size;
    if (size === undefined) c.fail(`${path}.size`, "required");
    else if (!Array.isArray(size) || size.length !== 2 || size.some((n) => !Number.isInteger(n) || n <= 0)) {
      c.fail(`${path}.size`, "must be [width, height] positive integers");
    } else {
      [width, height] = size as [number, number];
    }
    const scale = c.num(o.scale, `${path}.scale`, 1, 0.1, false);
    if (id !== null) screens.push({ id, url, extension, width, height, scale });
  });
  return screens;
}

function parseStep(c: Checker, raw: unknown, i: number, ids: Set<string>, baseDir: string): Step | null {
  const path = `steps[${i}]`;
  const o = c.obj(raw, path);
  if (!o) return null;
  c.keys(o, path, [...ACTION_KEYS, "retry"]);
  // `expect` next to another action is that action's expected state: retry re-runs the action until it holds (RM-01, S7).
  const others = ACTION_KEYS.filter((k) => k !== "expect" && k in o);
  const present = others.length === 0 && "expect" in o ? ["expect"] : others;
  if (present.length !== 1) {
    c.fail(path, present.length === 0 ? `exactly one action key required (${ACTION_KEYS.join(", ")})` : `exactly one action key allowed, found ${present.join(", ")}`);
    return null;
  }
  const retry = c.num(o.retry, `${path}.retry`, 0, 0, true);
  const kind = present[0];
  const p = `${path}.${kind}`;
  const value = o[kind];

  const screenRef = (body: Obj, at: string = p): string => {
    const id = c.str(body.screen, `${at}.screen`);
    if (id !== null && !ids.has(id)) c.fail(`${at}.screen`, `unknown screen "${id}"`);
    return id ?? "";
  };
  const body = (allowed: string[]): Obj | null => {
    const b = c.obj(value, p);
    if (b) c.keys(b, p, allowed);
    return b;
  };
  let expect: Expectation | null = null;
  if (kind !== "expect" && "expect" in o) {
    const at = `${path}.expect`;
    const b = c.obj(o.expect, at);
    if (b) {
      c.keys(b, at, ["screen", "selector"]);
      const screen = screenRef(b, at);
      const selector = c.str(b.selector, `${at}.selector`);
      if (selector !== null) expect = { screen, selector };
    }
  }
  if (kind !== "expect" && retry > 0 && !("expect" in o)) c.fail(`${path}.retry`, "requires expect on the same step");
  const done = (action: Action): Step => ({ action, expect, retry });

  switch (kind) {
    case "goto": {
      const b = body(["screen", "url"]);
      if (!b) return null;
      return done({ kind, screen: screenRef(b), url: c.str(b.url, `${p}.url`) ?? "" });
    }
    case "click":
    case "dblclick": {
      const b = body(["screen", "target"]);
      if (!b) return null;
      const screen = screenRef(b);
      const t = target(c, b.target, `${p}.target`);
      return t ? done({ kind, screen, target: t }) : null;
    }
    case "drag": {
      const b = body(["screen", "from", "to"]);
      if (!b) return null;
      const screen = screenRef(b);
      const from = target(c, b.from, `${p}.from`);
      const to = target(c, b.to, `${p}.to`);
      return from && to ? done({ kind, screen, from, to }) : null;
    }
    case "type": {
      const b = body(["screen", "target", "text"]);
      if (!b) return null;
      const screen = screenRef(b);
      const t = target(c, b.target, `${p}.target`);
      const text = c.str(b.text, `${p}.text`);
      return t && text !== null ? done({ kind, screen, target: t, text }) : null;
    }
    case "press": {
      const b = body(["screen", "key"]);
      if (!b) return null;
      const screen = screenRef(b);
      const key = c.str(b.key, `${p}.key`);
      return key !== null ? done({ kind, screen, key }) : null;
    }
    case "wait": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        c.fail(p, "must be a number of milliseconds >= 0");
        return null;
      }
      return done({ kind, ms: value });
    }
    case "caption": {
      const text = c.str(value, p);
      return text === null ? null : done({ kind, text });
    }
    case "screen": {
      const id = c.str(value, p);
      if (id === null) return null;
      if (!ids.has(id)) c.fail(p, `unknown screen "${id}"`);
      return done({ kind, screen: id });
    }
    case "expect": {
      const b = body(["screen", "selector"]);
      if (!b) return null;
      const screen = screenRef(b);
      const selector = c.str(b.selector, `${p}.selector`);
      return selector !== null ? done({ kind, screen, selector }) : null;
    }
    default: {
      const rel = c.str(value, p);
      if (rel === null) return null;
      const path2 = resolve(baseDir, rel);
      if (!existsSync(path2)) {
        c.fail(p, `script file not found: ${rel}`);
        return null;
      }
      return done({ kind: "script", path: path2 });
    }
  }
}

export function parseScenario(text: string, file: string): Scenario {
  const c = new Checker();
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new ScenarioError([`yaml: ${(e as Error).message.split("\n")[0]}`]);
  }
  const root = c.obj(doc, "scenario");
  if (!root) throw new ScenarioError(c.errors);
  c.keys(root, "scenario", ["name", "caption", "screens", "layout", "state", "mask", "timing", "steps"]);

  const name = c.str(root.name, "name") ?? "";
  const screens = parseScreens(c, root.screens);
  const ids = new Set(screens.map((s) => s.id));
  screens.forEach((s, i) => {
    const pinTo = s.extension?.pinTo;
    if (pinTo != null && !screens.some((t) => t.id === pinTo && t.url !== null)) {
      c.fail(`screens[${i}].extension.pinTo`, `"${pinTo}" is not a screen with url`);
    }
  });

  const capRaw = root.caption === undefined ? {} : c.obj(root.caption, "caption") ?? {};
  c.keys(capRaw, "caption", ["lang", "position"]);
  const lang = c.strOr(capRaw.lang, "caption.lang", "en");
  const posRaw = capRaw.position === undefined ? {} : c.obj(capRaw.position, "caption.position") ?? {};
  const position: Record<string, "top" | "bottom"> = {};
  for (const id of Object.keys(posRaw)) {
    if (!ids.has(id)) c.fail(`caption.position.${id}`, `unknown screen "${id}"`);
  }
  for (const id of ids) position[id] = c.oneOf(posRaw[id], `caption.position.${id}`, ["top", "bottom"], "bottom");

  const layoutRaw = root.layout === undefined ? {} : c.obj(root.layout, "layout") ?? {};
  c.keys(layoutRaw, "layout", ["direction", "border"]);
  const layout = {
    direction: c.oneOf(layoutRaw.direction, "layout.direction", ["horizontal", "vertical"], "horizontal"),
    border: c.num(layoutRaw.border, "layout.border", 2, 0, true),
  };

  const stateRaw = root.state === undefined ? {} : c.obj(root.state, "state") ?? {};
  c.keys(stateRaw, "state", ["localStorage", "chromeStorage", "restoreViaBlankOrigin", "blankPath"]);
  let restore = false;
  if (stateRaw.restoreViaBlankOrigin !== undefined) {
    if (typeof stateRaw.restoreViaBlankOrigin === "boolean") restore = stateRaw.restoreViaBlankOrigin;
    else c.fail("state.restoreViaBlankOrigin", "must be true or false");
  }
  const blankPath = stateRaw.blankPath === undefined ? null : c.str(stateRaw.blankPath, "state.blankPath");
  if (restore && blankPath === null) c.fail("state.blankPath", "required when restoreViaBlankOrigin is true");
  const state = {
    localStorage: c.strList(stateRaw.localStorage, "state.localStorage"),
    chromeStorage: c.strList(stateRaw.chromeStorage, "state.chromeStorage"),
    restoreViaBlankOrigin: restore,
    blankPath,
  };

  const timingRaw = root.timing === undefined ? {} : c.obj(root.timing, "timing") ?? {};
  c.keys(timingRaw, "timing", ["stepTimeoutMs", "pointerSteps", "pointerStepMs", "frameMs", "contactSheetIntervalMs"]);
  const timing = {
    stepTimeoutMs: c.num(timingRaw.stepTimeoutMs, "timing.stepTimeoutMs", 30000, 1, true),
    pointerSteps: c.num(timingRaw.pointerSteps, "timing.pointerSteps", 12, 1, true),
    pointerStepMs: c.num(timingRaw.pointerStepMs, "timing.pointerStepMs", 33, 0, true),
    frameMs: c.num(timingRaw.frameMs, "timing.frameMs", DEFAULT_FRAME_MS, 1, true),
    contactSheetIntervalMs: c.num(timingRaw.contactSheetIntervalMs, "timing.contactSheetIntervalMs", 2400, 1, true),
  };

  const mask = c.strList(root.mask, "mask");

  const steps: Step[] = [];
  if (!Array.isArray(root.steps) || root.steps.length === 0) c.fail("steps", "required: non-empty list");
  else {
    const baseDir = dirname(resolve(file));
    root.steps.forEach((raw, i) => {
      const step = parseStep(c, raw, i, ids, baseDir);
      if (step) steps.push(step);
    });
  }

  if (c.errors.length > 0) throw new ScenarioError(c.errors);
  return { file: resolve(file), name, caption: { lang, position }, screens, layout, state, mask, timing, steps };
}

export function loadScenario(file: string): Scenario {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ScenarioError([`file: cannot read ${file}: ${(e as Error).message}`]);
  }
  return parseScenario(text, file);
}
