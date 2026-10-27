# reel-mesh

한국어 | [English](README.md)

웹 프로젝트의 README에 넣을 시연 GIF를 시나리오 파일로 녹화합니다. 시나리오(YAML)에 클릭, 입력, 자막을 단계별로 적으면, reel-mesh가 브라우저를 띄워 단계마다 화면을 찍고 GIF로 합칩니다. 시나리오는 저장소에 남으므로 기능이 바뀌면 같은 명령으로 같은 길이의 영상을 다시 만들 수 있습니다.

웹앱과 정적 HTML 페이지, Chrome 확장의 사이드 패널을 찍을 수 있습니다. 페이지와 패널처럼 두 화면을 나란히 붙여 한 영상으로 만들 수도 있습니다. 실제 포인터는 화면 캡처에 찍히지 않으므로, 가짜 포인터와 클릭 표시, 자막을 페이지 위에 그려서 함께 찍습니다.

CLI와 함께 AI 코딩 에이전트용 skill이 들어 있습니다. 에이전트는 이 skill을 따라 프로젝트를 읽고 시연 후보를 제안한 뒤, 사용자가 고른 후보를 녹화하고 README에 넣습니다. Claude Code, Codex, Cursor, Kiro, Antigravity, OpenCode에 설치할 수 있습니다.

## 설치

Node.js와 `ffmpeg`가 PATH에 있어야 합니다. Node.js는 TypeScript 파일을 빌드 없이 실행하며, v26.12.1과 `ffmpeg` 9.0.2에서 확인했습니다.

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash
```

설치 스크립트는 다음 순서로 진행합니다.

1. 저장소를 `~/.local/share/reel-mesh`에 받고 `npm ci --omit=dev`, `npx playwright install chromium`을 실행합니다.
2. `~/.local/bin/reel-mesh` 명령을 만듭니다. 이 폴더가 PATH에 없으면 추가하라고 알려 줍니다.
3. 이 컴퓨터에 있는 AI 코딩 도구를 찾아 보여 주고, 확인을 받은 뒤 skill을 등록합니다. 묻지 않고 등록하려면 `bash -s -- --yes`를 붙입니다.

| 도구 | 찾는 기준 | 등록하는 곳 |
|---|---|---|
| Claude Code | `claude` 명령 | `~/plugins/reel-mesh`를 로컬 마켓플레이스로 추가하고 `claude plugin install reel-mesh@reel-mesh -s user` |
| Codex | `codex` 명령 | `~/plugins/reel-mesh`를 `~/.agents/plugins/marketplace.json`에 추가하고 `codex plugin add reel-mesh@<마켓플레이스 이름>` |
| Cursor | `~/.cursor` | `~/.cursor/skills/reel-mesh/` |
| Kiro | `~/.kiro` | `~/.kiro/steering/reel-mesh*.md` |
| Antigravity | `~/.gemini` | `~/.gemini/antigravity/skills/reel-mesh.md`, `~/.gemini/AGENTS.md`의 reel-mesh 블록 |
| OpenCode | `~/.config/opencode` 또는 `opencode` 명령 | `~/.config/opencode/skills/reel-mesh/SKILL.md` |

등록한 뒤에는 각 도구에서 새 세션을 시작해야 skill이 로드됩니다.

등록 대상을 직접 고르거나 나중에 다시 등록할 때는 설치된 CLI를 씁니다. 이 도구가 만들지 않은 파일이 이미 있으면 덮어쓰지 않고, `--force`를 붙여야 덮어씁니다.

```bash
reel-mesh setup install --targets codex,cursor --yes   # --targets 없이 실행하면 찾은 도구 전부
reel-mesh setup status
reel-mesh setup uninstall --yes
```

전부 지우려면 설치 스크립트에 `uninstall`을 붙입니다. 등록한 skill, `reel-mesh` 명령, `~/.local/share/reel-mesh`를 지웁니다.

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash -s -- uninstall
```

Claude Code만 쓴다면 플러그인으로 skill만 설치할 수도 있습니다. 이때도 녹화하려면 `reel-mesh` 명령이 있어야 하므로 위 설치 스크립트를 실행해야 합니다.

```text
/plugin install reel-mesh --marketplace x-mesh/reel-mesh
```

## 처음 써 보기

설치된 폴더에 들어 있는 시험용 앱으로 녹화부터 GIF까지 실행해 봅니다. 시험용 앱 서버를 다른 터미널에서 띄웁니다.

```bash
cd ~/.local/share/reel-mesh
node examples/fixture-app/serve.ts --port 5173
```

같은 폴더에서 다음 명령을 차례로 실행합니다.

```bash
cd ~/.local/share/reel-mesh
reel-mesh check examples/scenarios/fixture-app.yaml
reel-mesh record examples/scenarios/fixture-app.yaml
reel-mesh review examples/scenarios/fixture-app.yaml
reel-mesh render examples/scenarios/fixture-app.yaml
```

산출물은 명령을 실행한 폴더의 `.reel/fixture-app/` 아래에 생깁니다.

- `frames/`, `frames.json`: 단계별 프레임과 프레임마다 보여 줄 시간
- `run.log`: 단계 이름, 시각, 찍은 프레임 수
- `review/contact-sheet.png`, `review/step-<n>.png`: 검토용 장면 모음과 단계별 마지막 프레임
- `fixture-app.gif`: 결과 GIF

페이지와 확장 사이드 패널을 함께 찍는 예시는 `examples/scenarios/fixture-ext.yaml`입니다. 같은 서버를 띄운 상태에서 위 명령의 시나리오 경로만 바꿔 실행하면 1402×760 GIF가 나옵니다.

## 시나리오

```yaml
name: my-demo
screens:
  - id: page
    url: http://127.0.0.1:5173/
    size: [1040, 760]
steps:
  - caption: "Select the title"
  - click: { screen: page, target: "h1" }
    expect: { screen: page, selector: "h1" }
    retry: 2
  - dblclick: { screen: page, target: { text: "Click me" } }
  - wait: 800
```

대상은 좌표가 아니라 CSS selector나 문구로 지정하고, 좌표는 녹화 중에 계산합니다. 그래서 화면 크기를 바꿔도 시나리오를 고치지 않아도 됩니다. 동작 단계에 `expect`를 붙이면 기대 상태가 맞을 때까지 그 동작을 `retry`만큼 다시 실행하고, 그래도 맞지 않으면 녹화를 실패로 끝냅니다. 틀린 화면을 그대로 GIF에 남기지 않기 위해서입니다.

영상 속도는 실제 캡처 시간이 아니라 시나리오의 시간 값으로 정해집니다. 같은 시나리오를 두 번 녹화하면 프레임 수와 길이가 같습니다.

필드 전체와 기본값은 [skills/reel-mesh/references/scenario-format.md](skills/reel-mesh/references/scenario-format.md)에 있습니다.

## 명령

| 명령 | 하는 일 |
|---|---|
| `validate <scenario>` | 시나리오 문법을 확인합니다. 브라우저를 띄우지 않습니다. |
| `check <scenario> [--adapter]` | ffmpeg, 개발 서버, 브라우저, 확장, 첫 대상 요소를 점검합니다. 실패하면 할 일을 한 줄로 알려 줍니다. |
| `record <scenario> [--adapter]` | 사전 점검을 통과하면 단계마다 모든 화면을 찍습니다. |
| `restore <scenario> [--adapter]` | 녹화가 남긴 저장값 스냅숏으로 브라우저 상태를 되돌립니다. |
| `review <scenario>` | 장면 모음과 단계별 마지막 프레임을 만듭니다. |
| `render <scenario> [--width <px>] [--colors <n>] [--budget-mb <n>] [--mp4 [path]]` | GIF를 만들고, 선택하면 MP4도 만듭니다. 크기 예산을 넘으면 폭과 색 수를 줄인 명령을 제안합니다. |
| `audit <scenario> --deny-file <path>` | 시나리오와 산출물 텍스트에 금지 문자열이 있는지 검사합니다. |

모든 명령은 `reel-mesh <명령>` 형태로 실행합니다. 인자 없이 실행하면 usage가 나옵니다. skill 등록은 `reel-mesh setup`이 맡습니다(설치 절 참고).

exit code는 1 실행 실패, 2 시나리오나 인자 오류, 3 사전 점검 실패, 4 복원 뒤 저장값 불일치, 5 이전 녹화의 스냅숏이 남아 있음, 6 금지 문자열 발견입니다.

## 브라우저 상태 보관과 복원

시나리오의 `state`에 `localStorage`나 확장 `chrome.storage` 키를 적으면, `record`가 녹화 전에 그 값을 `.reel/<name>/state-snapshot.json`에 보관하고 지운 뒤 깨끗한 상태로 녹화합니다. 녹화가 오류로 끝나도 보관한 값을 되돌리고, 되돌린 값이 녹화 전과 같은지 비교해 `state-restore.json`에 씁니다. 프로세스가 강제로 종료되어 스냅숏이 남으면, 다음 `record`는 녹화하지 않고 `restore` 명령을 안내합니다.

## 브라우저 어댑터

- `playwright`(기본): 임시 프로필로 새 Chromium을 띄우므로 사용자의 브라우저를 건드리지 않습니다. 확장 화면도 지원합니다.
- `ego-browser`: 사용자가 쓰는 브라우저를 직접 조작합니다. 확장 화면은 지원하지 않습니다. 가짜 실행 파일로만 시험했고, 실제 ego-browser에서는 아직 확인하지 않았습니다. 확인할 항목과 명령은 [docs/spike-notes.md](docs/spike-notes.md)에 있습니다.

스냅숏은 녹화한 어댑터로만 복원할 수 있습니다. 다른 어댑터로 `restore`를 실행하면 exit 2로 거부하고 맞는 명령을 출력합니다.

## AI 에이전트 skill

[skills/reel-mesh/SKILL.md](skills/reel-mesh/SKILL.md)는 에이전트가 따르는 절차입니다. 시연 후보를 고르고, 시나리오를 쓰고, 녹화하고, 검토하고, GIF로 변환한 뒤 README에 넣습니다. 사용자에게는 두 번 묻습니다. 어떤 후보를 녹화할지, 그리고 README에 넣기 전에 결과 GIF가 괜찮은지입니다.

에이전트는 대상 프로젝트의 루트에서 `reel-mesh` 명령을 실행합니다. 그래서 `.reel/`은 대상 프로젝트에 생기고, skill은 그 프로젝트의 `.gitignore`에 `.reel/`을 넣도록 안내합니다. `reel-mesh` 명령이 없으면 녹화하지 않고 설치 명령을 안내합니다.

## 한계

- 소리, OS 화면 녹화, 브라우저 밖 데스크톱 앱, 영상 편집은 지원하지 않습니다.
- `audit`은 이미지 속 글자를 검사하지 않습니다. 화면에 보이는 개인정보는 시나리오의 `mask`로 가리고, 검토 단계에서 이미지를 직접 확인해야 합니다.
- `mask`는 최상위 문서의 요소만 찾습니다. iframe이나 shadow DOM 안의 요소는 가리지 못합니다.
- 확장은 background service worker가 있어야 이름으로 찾을 수 있습니다.

## 개발

저장소에서 직접 실행할 때는 의존성을 받은 뒤 `node bin/reel-mesh.ts <명령>`으로 실행합니다. `scripts/install.sh`를 저장소 안에서 실행하면 GitHub 대신 그 저장소를 설치합니다.

```bash
npm i
npx playwright install chromium
npm test
npm run typecheck
```

`npm test`는 브라우저를 띄우는 시험을 포함해 순서대로 실행하며, 약 2분이 걸립니다.

## 라이선스

[MIT](LICENSE)
