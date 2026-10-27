import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, parseScenario } from "../src/scenario.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = join(root, "skill");
const scenariosDir = join(root, "examples", "scenarios");
const docFiles = ["SKILL.md", "references/selection.md", "references/scenario-format.md", "references/review-checklist.md"];
const read = (rel: string) => readFileSync(join(skillDir, rel), "utf8");
const allDocs = docFiles.map((f) => ({ file: f, text: read(f) }));
const CLI_CALL = /node\s+"?\S*bin\/reel-mesh\.ts"?\s+([a-z-]+)/g;
const CLI_COMMANDS = ["validate", "check", "record", "restore", "review", "render", "audit"];

test("SKILL.md frontmatter has name and trigger phrases", () => {
  const text = read("SKILL.md");
  const match = /^---\nname: reel-mesh\ndescription: (.+)\n---\n/.exec(text);
  assert.ok(match, "frontmatter with name: reel-mesh");
  for (const phrase of ["README 시연 영상 만들어 줘", "데모 GIF 다시 찍어 줘"]) assert.ok(match[1]!.includes(phrase), phrase);
});

test("SKILL.md has the required sections and rules", () => {
  const text = read("SKILL.md");
  const required = [
    "## CLI 실행 방법",
    "## 어댑터",
    "## 단계",
    "## 행동 규칙",
    "## README 삽입",
    "## 한계",
    "npm i",
    "npx playwright install chromium",
    ".gitignore",
    "`.reel/`",
    "../bin/reel-mesh.ts",
    "사용자 확인 1",
    "사용자 확인 2",
    "| head",
    "반영",
    "같은 실패가 두 번",
    "녹화 전 값",
    "언어별 README",
    "대체 텍스트",
    "다시 만드는 명령",
    "--adapter ego-browser",
    "확장 화면은 지원하지 않는다",
    "수동 확인 전",
    "이미지 속 글자는 검사하지 않는다",
  ];
  for (const phrase of required) assert.ok(text.includes(phrase), `SKILL.md missing: ${phrase}`);
  const order = ["1. 선정", "2. 시나리오 작성", "3. 사전 점검", "4. 녹화", "5. 검토", "6. 변환", "7. 삽입", "8. 정리"].map((p) => text.indexOf(p));
  assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]!)), "steps in order");
});

test("references carry their required content", () => {
  const selection = read("references/selection.md");
  for (const phrase of ["보여 줄 기능과 순서", "단계별 자막과 기대 상태", "화면 구성과 크기", "예상 길이", "필요한 준비", "녹화가 어려운 장면", "추천", "## 4. 선정 기준", "F11", "질문은 한 번"]) {
    assert.ok(selection.includes(phrase), `selection.md missing: ${phrase}`);
  }
  const checklist = read("references/review-checklist.md");
  for (const phrase of ["열린 채 남은 메뉴", "가려진 버튼", "이전 상태 복원", "꺾인 글자", "mask", "다른 탭 제목", "이미지 속 글자를 검사하지 않는다"]) {
    assert.ok(checklist.includes(phrase), `review-checklist.md missing: ${phrase}`);
  }
});

test("every documented CLI command exists", () => {
  const cli = readFileSync(join(root, "bin", "reel-mesh.ts"), "utf8");
  let found = 0;
  for (const { file, text } of allDocs) {
    for (const m of text.matchAll(CLI_CALL)) {
      found++;
      assert.ok(CLI_COMMANDS.includes(m[1]!), `${file}: unknown command ${m[1]}`);
      assert.ok(new RegExp(`^\\s+${m[1]}:`, "m").test(cli), `${file}: ${m[1]} not registered in bin/reel-mesh.ts`);
    }
  }
  assert.ok(found > 0);
  for (const command of CLI_COMMANDS) assert.ok(read("SKILL.md").includes(`\`${command}`), `SKILL.md omits ${command}`);
});

test("selection procedure does not tell the agent to run record, review or render", () => {
  const selection = read("references/selection.md");
  const commands = [...selection.matchAll(CLI_CALL)].map((m) => m[1]);
  assert.deepEqual(commands, ["validate"]);
  assert.match(selection, /`record`, `review`, `render`를 실행하지 않는다/);
});

test("yaml code blocks in the docs load as scenarios", () => {
  let blocks = 0;
  for (const { file, text } of allDocs) {
    for (const m of text.matchAll(/```yaml\n([\s\S]*?)```/g)) {
      blocks++;
      assert.doesNotThrow(() => parseScenario(m[1]!, join(scenariosDir, "doc-block.yaml")), `${file}: yaml block ${blocks}`);
    }
  }
  assert.ok(blocks >= 2);
});

test("selected-example.yaml loads and the examples folder stays loadable", () => {
  const scenario = loadScenario(join(scenariosDir, "selected-example.yaml"));
  assert.equal(scenario.name, "selected-example");
  assert.ok(readdirSync(scenariosDir).includes("selected-example.yaml"));
});
