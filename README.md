# reel-mesh

웹 프로젝트의 README에 넣을 시연 GIF를 시나리오 파일로 녹화합니다. 시나리오(YAML)에 클릭, 입력, 자막을 단계별로 적으면, reel-mesh가 브라우저를 띄워 단계마다 화면을 찍고 GIF로 합칩니다. 시나리오는 저장소에 남으므로 기능이 바뀌면 같은 명령으로 같은 길이의 영상을 다시 만들 수 있습니다.

웹앱과 정적 HTML 페이지, Chrome 확장의 사이드 패널을 찍을 수 있습니다. 페이지와 패널처럼 두 화면을 나란히 붙여 한 영상으로 만들 수도 있습니다. 실제 포인터는 화면 캡처에 찍히지 않으므로, 가짜 포인터와 클릭 표시, 자막을 페이지 위에 그려서 함께 찍습니다.

CLI와 함께 AI 코딩 에이전트용 skill(`skill/`)이 들어 있습니다. 에이전트는 이 skill을 따라 프로젝트를 읽고 시연 후보를 제안한 뒤, 사용자가 고른 후보를 녹화하고 README에 넣습니다.

## 준비

- Node.js: TypeScript 파일을 빌드 없이 실행합니다. v26.12.1에서 확인했습니다.
- `ffmpeg`: PATH에 있어야 합니다. 9.0.2에서 확인했습니다.

```bash
npm i
npx playwright install chromium
```

## 처음 써 보기

저장소에 들어 있는 시험용 앱으로 녹화부터 GIF까지 실행해 봅니다. 시험용 앱 서버를 다른 터미널에서 띄웁니다.

```bash
node examples/fixture-app/serve.ts --port 5173
```

저장소 루트에서 다음 명령을 차례로 실행합니다.

```bash
node bin/reel-mesh.ts check examples/scenarios/fixture-app.yaml
node bin/reel-mesh.ts record examples/scenarios/fixture-app.yaml
node bin/reel-mesh.ts review examples/scenarios/fixture-app.yaml
node bin/reel-mesh.ts render examples/scenarios/fixture-app.yaml
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

필드 전체와 기본값은 [skill/references/scenario-format.md](skill/references/scenario-format.md)에 있습니다.

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

모든 명령은 `node bin/reel-mesh.ts <명령>` 형태로 실행합니다. 인자 없이 실행하면 usage가 나옵니다.

exit code는 1 실행 실패, 2 시나리오나 인자 오류, 3 사전 점검 실패, 4 복원 뒤 저장값 불일치, 5 이전 녹화의 스냅숏이 남아 있음, 6 금지 문자열 발견입니다.

## 브라우저 상태 보관과 복원

시나리오의 `state`에 `localStorage`나 확장 `chrome.storage` 키를 적으면, `record`가 녹화 전에 그 값을 `.reel/<name>/state-snapshot.json`에 보관하고 지운 뒤 깨끗한 상태로 녹화합니다. 녹화가 오류로 끝나도 보관한 값을 되돌리고, 되돌린 값이 녹화 전과 같은지 비교해 `state-restore.json`에 씁니다. 프로세스가 강제로 종료되어 스냅숏이 남으면, 다음 `record`는 녹화하지 않고 `restore` 명령을 안내합니다.

## 브라우저 어댑터

- `playwright`(기본): 임시 프로필로 새 Chromium을 띄우므로 사용자의 브라우저를 건드리지 않습니다. 확장 화면도 지원합니다.
- `ego-browser`: 사용자가 쓰는 브라우저를 직접 조작합니다. 확장 화면은 지원하지 않습니다. 가짜 실행 파일로만 시험했고, 실제 ego-browser에서는 아직 확인하지 않았습니다. 확인할 항목과 명령은 [docs/spike-notes.md](docs/spike-notes.md)에 있습니다.

스냅숏은 녹화한 어댑터로만 복원할 수 있습니다. 다른 어댑터로 `restore`를 실행하면 exit 2로 거부하고 맞는 명령을 출력합니다.

## AI 에이전트 skill

[skill/SKILL.md](skill/SKILL.md)는 에이전트가 따르는 절차입니다. 시연 후보를 고르고, 시나리오를 쓰고, 녹화하고, 검토하고, GIF로 변환한 뒤 README에 넣습니다. 사용자에게는 두 번 묻습니다. 어떤 후보를 녹화할지, 그리고 README에 넣기 전에 결과 GIF가 괜찮은지입니다.

에이전트는 대상 프로젝트의 루트에서 이 저장소의 `bin/reel-mesh.ts`를 절대 경로로 실행합니다. 그래서 `.reel/`은 대상 프로젝트에 생기고, skill은 그 프로젝트의 `.gitignore`에 `.reel/`을 넣도록 안내합니다.

Claude Code에서 쓰려면 skill 폴더를 개인 skill 경로에 연결합니다.

```bash
ln -s "$PWD/skill" ~/.claude/skills/reel-mesh
```

## 한계

- 소리, OS 화면 녹화, 브라우저 밖 데스크톱 앱, 영상 편집은 지원하지 않습니다.
- `audit`은 이미지 속 글자를 검사하지 않습니다. 화면에 보이는 개인정보는 시나리오의 `mask`로 가리고, 검토 단계에서 이미지를 직접 확인해야 합니다.
- `mask`는 최상위 문서의 요소만 찾습니다. iframe이나 shadow DOM 안의 요소는 가리지 못합니다.
- 확장은 background service worker가 있어야 이름으로 찾을 수 있습니다.

## 개발

```bash
npm test
npm run typecheck
```

`npm test`는 브라우저를 띄우는 시험을 포함해 순서대로 실행하며, 약 2분 20초가 걸립니다.
