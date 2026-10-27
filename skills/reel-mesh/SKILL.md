---
name: reel-mesh
description: 웹 프로젝트(웹앱, Chrome 확장, 정적 HTML)의 README 시연 GIF를 시나리오 파일로 만들고 다시 찍는 skill. 무엇을 보여 줄지 고르는 선정부터 녹화, 검토, GIF 변환, README 삽입까지 진행한다. "README 시연 영상 만들어 줘", "데모 GIF 다시 찍어 줘", "시연 GIF 갱신", "기능이 바뀌었으니 데모 다시 녹화", "README에 들어갈 데모 후보 골라 줘" 같은 요청에 쓴다.
---

# reel-mesh

시연 GIF를 시나리오 파일(YAML)로 정의하고, 같은 명령으로 몇 번이든 같은 결과로 다시 만든다. 이 skill은 사용자의 웹 프로젝트에서 쓰이고, CLI는 설치 스크립트가 PATH에 둔다.

## CLI 실행 방법

이 skill은 PATH에 설치된 `reel-mesh` 명령을 쓴다.

1. `command -v reel-mesh`로 설치 여부를 확인한다. 없으면 녹화를 진행하지 않고, 사용자에게 아래 설치 명령을 안내한다. 이 명령은 `npm ci`로 의존성을 받고 `npx playwright install chromium`으로 브라우저를 받는다. `ffmpeg`는 미리 PATH에 있어야 한다.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash
   ```

2. 명령은 대상 프로젝트의 루트에서 실행한다. 산출물 `.reel/`이 그 프로젝트에 생기기 때문이다.

```bash
reel-mesh <command> ...
```

명령은 `validate`, `check`, `record`, `restore`, `review`, `render`, `audit` 일곱 개다. 옵션은 인자 없이 실행하면 나오는 usage로 확인한다. 상세 필드는 `references/scenario-format.md`에 있다.

| 명령 | 하는 일 | 주요 exit code |
|---|---|---|
| `validate <scenario>` | 시나리오 문법 확인 | 0, 2 |
| `check <scenario> [--adapter]` | 사전 점검(서버, 브라우저, 확장, 첫 대상 요소, ffmpeg) | 0, 3 |
| `record <scenario> [--adapter]` | 사전 점검 후 단계별 촬영 | 0, 1, 3, 4, 5 |
| `restore <scenario> [--adapter]` | 녹화가 남긴 저장값 스냅숏으로 복원 | 0, 2, 4 |
| `review <scenario>` | 장면 모음과 단계별 마지막 프레임 생성 | 0, 1 |
| `render <scenario> [--width] [--colors] [--budget-mb] [--mp4 [path]]` | GIF(선택: MP4) 변환 | 0, 1 |
| `audit <scenario> --deny-file <path>` | 금지 문자열 검사 | 0, 6 |

exit code: 1 실행 실패, 2 시나리오 오류나 usage 오류, 3 사전 점검 실패, 4 복원 후 저장값 불일치, 5 이전 녹화의 스냅숏이 남아 있음, 6 금지 문자열 발견.

산출물은 모두 `.reel/<name>/` 아래에 생긴다: `frames/`, `frames.json`, `run.log`, `review/contact-sheet.png`, `review/step-<n>.png`, `<name>.gif`. 시나리오 파일은 `.reel/` 밖(예: `demo/<name>.yaml`)에 두고 저장소에 커밋한다.

## 어댑터

- 기본은 `playwright`다. 임시 프로필로 새 Chromium을 띄우므로 사용자의 브라우저와 프로필을 건드리지 않는다. 확장 화면도 지원한다.
- `--adapter ego-browser`는 사용자가 쓰는 브라우저를 직접 조작한다. 사용자 허락을 받은 뒤에만 쓴다. 확장 화면은 지원하지 않는다. 실제 동작은 아직 수동 확인 전이다.
- `check`, `record`, `restore`는 같은 어댑터로 맞춘다. 스냅숏은 녹화한 어댑터로만 복원되고, 다른 어댑터로 `restore`하면 exit 2로 거부하며 맞는 명령을 출력한다.

## 단계

각 단계는 앞 단계가 끝난 뒤에 진행한다.

1. 선정: `references/selection.md`를 따른다. 저장소를 읽고 스토리보드 후보 1~3개와 추천을 낸다. 이 단계에서 `record`, `review`, `render`를 실행하지 않는다.
   - 사용자 확인 1: 어떤 후보로 녹화할지 묻는다. 질문은 한 번이다.
2. 시나리오 작성: 고른 후보를 `references/scenario-format.md`의 형식으로 파일에 쓴다. `validate`가 exit 0이어야 한다. 대상 프로젝트의 `.gitignore`에 `.reel/`이 없으면 넣는다(프레임과 중간 파일은 커밋하지 않는다).
3. 사전 점검: `check`를 실행한다. 실패 항목마다 출력된 할 일을 따른다. 개발 서버가 꺼져 있으면 사용자의 실행 방법(`package.json` 스크립트, `Makefile`)으로 띄운다. `record`도 시작할 때 같은 점검을 하므로, 서버를 막 띄웠다면 생략해도 된다.
4. 녹화: `record`를 실행한다. 출력은 파일로 받는다(아래 규칙). 실패하면 출력의 실패 단계, 오류, 마지막 프레임 경로를 보고 시나리오를 고친다.
5. 검토: `review`를 실행하고 `.reel/<name>/review/`의 이미지를 직접 열어 `references/review-checklist.md`의 항목을 확인한다. 문제가 있으면 2단계로 돌아가 시나리오를 고치고 다시 녹화한다. 공개 저장소라면 `audit`도 실행한다.
6. 변환: `render`를 실행한다. 크기 예산(기본 3MB)을 넘으면 출력이 제안하는 명령(`--width`, `--colors` 값 포함)으로 다시 변환한다. 제안 명령은 CLI 절대 경로를 담고 있어 대상 프로젝트 루트에서 그대로 실행할 수 있다. MP4가 필요하면 `--mp4`를 붙인다.
   - 사용자 확인 2: README에 넣기 전에 결과 GIF(`.reel/<name>/<name>.gif`)를 사용자에게 보여 주고 괜찮은지 묻는다. 승인 전에는 README를 고치지 않는다.
7. 삽입: 아래 README 삽입 절차를 따른다.
8. 정리: `.reel/<name>/state-snapshot.json`이 남아 있지 않은지 확인한다. 남아 있으면(exit 5나 4) `restore`로 되돌린다. 녹화에 쓴 서버와 탭을 닫는다. 사용자가 띄운 것이 아닌 프로세스만 종료한다.

## 행동 규칙

- 녹화 명령의 출력은 파일로 받고 파일을 읽는다. `| head`, `| grep` 같은 파이프로 거르지 않는다. 걸러 둔 출력은 멈춘 것처럼 보이고 시간 제한만 채운다(F1, F2).

  ```bash
  mkdir -p .reel
  reel-mesh record demo/app.yaml > .reel/record.out 2>&1; echo "exit=$?"
  ```

- 시나리오를 고친 뒤에는 파일에 반영됐는지 읽어서 확인하고, `validate`를 통과시킨 뒤 녹화한다. 반영을 확인하지 않고 다시 녹화하지 않는다(F3).
- 같은 실패가 두 번 나면 같은 방법을 반복하지 않는다. 멈추고 실패한 단계, 오류, `.reel/<name>/run.log`의 근거, 추정 원인을 사용자에게 보고한다.
- 사용자의 브라우저 설정이나 저장값을 바꾸기 전에 녹화 전 값을 기록한다. Playwright 어댑터의 임시 프로필은 해당하지 않는다. 시나리오의 `state`에 쓴 키는 `record`가 스냅숏으로 보관하고 끝나면 복원한다. 그 밖의 값을 직접 바꿀 때는 먼저 값을 파일이나 보고에 남긴다.
- 스냅숏이 남아 있으면(exit 5) 새로 녹화하지 않고 `restore`를 먼저 실행한다.
- 사용자 확인 두 번 외에는 사용자에게 묻지 않고 진행한다. 다만 위 어댑터, 파괴적 작업, README 구조 변경은 그 앞에서 묻는다.

## README 삽입

1. GIF를 프로젝트에서 커밋할 위치로 복사한다. 이미 시연 이미지가 있으면 그 폴더를 쓰고, 없으면 `docs/media/<name>.gif`를 제안한다. `.reel/`은 `.gitignore` 대상이므로 거기서 바로 링크하지 않는다.
2. README에서 시연이 들어갈 위치(소개 문단 바로 아래, 기존 시연 이미지 자리)를 찾아 이미지를 넣는다. 기존 이미지가 있으면 교체한다.
3. 언어별 README(`README.md`, `README.ko.md` 등)가 있으면 모두에 넣는다. 자막은 README 기본 언어로 쓰되, 대체 텍스트는 각 README의 언어로 쓴다.
4. 대체 텍스트에는 영상이 보여 주는 동작을 한 문장으로 쓴다. 예: `![Selecting a layer and docking the side panel](docs/media/demo.gif)`.
5. 다시 만드는 명령(`make demo`나 `package.json` 스크립트)을 README나 빌드 파일에 추가할지 사용자에게 묻는다. 묻기만 하고 승인 전에는 추가하지 않는다.

## 한계

- `audit`은 시나리오, 스크립트, `.reel/<name>/` 안의 텍스트 파일에서 금지 문자열을 찾는다. 이미지 속 글자는 검사하지 않는다. 화면에 보이는 값은 시나리오의 `mask`로 가리고, 검토 단계에서 이미지를 직접 확인한다.
- 소리, OS 화면 녹화, 브라우저 밖 앱, 영상 편집은 지원하지 않는다.
