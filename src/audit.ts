import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Scenario } from "./scenario.ts";

export const EXIT_AUDIT_FOUND = 6;
const EXIT_AUDIT_USAGE = 2;
const BINARY_PROBE_BYTES = 8192;

export interface AuditFinding {
  file: string;
  line: number;
  item: number;
  masked: string;
}

// Only the first two characters are kept so the audit output itself can be published without leaking the denied value.
function maskedPrefix(value: string): string {
  return `${value.slice(0, Math.min(2, value.length - 1))}***`;
}

function readDenyList(path: string): string[] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function readText(path: string): string | null {
  const bytes = readFileSync(path);
  return bytes.subarray(0, BINARY_PROBE_BYTES).includes(0) ? null : bytes.toString("utf8");
}

export function auditTargets(scenario: Scenario, baseDir: string = process.cwd()): string[] {
  const scripts = scenario.steps.flatMap((step) => (step.action.kind === "script" ? [step.action.path] : []));
  const workspace = listFiles(join(baseDir, ".reel", scenario.name));
  return [...new Set([scenario.file, ...scripts, ...workspace])];
}

export function auditFiles(files: string[], denied: string[]): { findings: AuditFinding[]; scanned: number } {
  const findings: AuditFinding[] = [];
  let scanned = 0;
  for (const file of files) {
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const text = readText(file);
    if (text === null) continue;
    scanned++;
    for (const [i, content] of text.split("\n").entries()) {
      denied.forEach((value, k) => {
        if (content.includes(value)) findings.push({ file, line: i + 1, item: k + 1, masked: maskedPrefix(value) });
      });
    }
  }
  return { findings, scanned };
}

export function runAudit(
  scenario: Scenario,
  denyFile: string,
  write: (line: string) => void = console.log,
  baseDir: string = process.cwd(),
): number {
  let denied: string[];
  try {
    denied = readDenyList(denyFile);
  } catch (e) {
    write(`FAIL audit: 금지 문자열 파일을 읽지 못했습니다 (${denyFile}): ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_AUDIT_USAGE;
  }
  if (denied.length === 0) {
    write(`FAIL audit: 금지 문자열 파일에 항목이 없습니다 (${denyFile}). 한 줄에 문자열 하나씩 적으세요`);
    return EXIT_AUDIT_USAGE;
  }
  const { findings, scanned } = auditFiles(auditTargets(scenario, baseDir), denied);
  for (const f of findings) {
    write(`${relative(baseDir, f.file) || f.file}:${f.line} 금지 문자열 ${f.item}번 항목 (${f.masked})`);
  }
  write("참고: 이미지 속 글자는 검사하지 않습니다. 화면에 보이는 값은 mask로 가리고 검토 단계에서 이미지를 직접 확인하세요");
  if (findings.length > 0) {
    write(`audit: 금지 문자열 ${findings.length}건 발견 (${scanned}개 파일 검사)`);
    return EXIT_AUDIT_FOUND;
  }
  write(`audit: 금지 문자열 없음 (${scanned}개 파일 검사)`);
  return 0;
}
