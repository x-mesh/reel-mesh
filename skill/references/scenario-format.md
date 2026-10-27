# 시나리오 파일 형식

YAML 파일 하나가 시연 하나다. 모르는 키는 `validate`가 `unknown key`로 거부한다. 상대 경로(`script`, `extension.path`)는 시나리오 파일이 있는 폴더 기준이다.

## 최상위 필드

| 필드 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `name` | 예 | 없음 | 산출물 폴더 `.reel/<name>/`과 GIF 이름 |
| `caption.lang` | 아니오 | `en` | 자막 언어 표시 |
| `caption.position` | 아니오 | 화면마다 `bottom` | `{ <screen id>: top or bottom }`. 자막이 버튼을 가리면 `top` |
| `screens` | 예 | 없음 | 화면 목록(아래) |
| `layout.direction` | 아니오 | `horizontal` | `horizontal` 또는 `vertical` |
| `layout.border` | 아니오 | `2` | 화면 사이 경계선 픽셀 |
| `state.localStorage` | 아니오 | `[]` | 보관하고 복원할 `localStorage` 키. `fixture:*`처럼 `*`를 쓴다 |
| `state.chromeStorage` | 아니오 | `[]` | 보관하고 복원할 확장 `chrome.storage` 키 |
| `state.restoreViaBlankOrigin` | 아니오 | `false` | 페이지를 떠날 때 다시 저장하는 앱이면 `true`. 앱이 없는 주소로 이동한 뒤 복원한다 |
| `state.blankPath` | 조건부 | 없음 | 위 값이 `true`일 때 필수. 앱이 없는 같은 출처의 경로 |
| `mask` | 아니오 | `[]` | 검은 상자로 가릴 요소의 CSS selector. 녹화 동안 한 번도 일치하지 않으면 경고 |
| `timing.stepTimeoutMs` | 아니오 | `30000` | 단계마다 제한 시간 |
| `timing.pointerSteps` | 아니오 | `12` | 포인터 이동 단계 수 |
| `timing.pointerStepMs` | 아니오 | `33` | 포인터 이동 단계당 시간 |
| `timing.frameMs` | 아니오 | `100` | 프레임 하나가 보이는 시간 |
| `timing.contactSheetIntervalMs` | 아니오 | `2400` | 장면 모음 간격 |
| `steps` | 예 | 없음 | 단계 목록(아래) |

## screens

화면마다 `id`, `size`, 그리고 `url`과 `extension` 중 정확히 하나가 필요하다.

| 필드 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `id` | 예 | 없음 | 단계에서 가리키는 이름. 중복 불가 |
| `url` | 조건부 | 없음 | 페이지 주소 |
| `extension.name` | 조건부 | 없음 | 확장 `manifest.json`의 이름. 확장 ID는 이름으로 찾는다 |
| `extension.path` | 조건부 | 없음 | 압축 해제된 확장 폴더 |
| `extension.page` | 아니오 | `panel.html` | 열 확장 페이지 |
| `extension.pinTo` | 아니오 | 없음 | 패널이 따라갈 화면의 `id`. `url`이 있는 화면만 가능. 사용자의 다른 탭에 붙는 것을 막는다(F4) |
| `size` | 예 | 없음 | `[너비, 높이]` 양의 정수 |
| `scale` | 아니오 | `1` | 0.1 이상 |

확장 화면은 playwright 어댑터에서만 동작한다.

## steps

단계마다 동작 키 하나를 쓴다.

| 동작 | 형태 |
|---|---|
| `goto` | `{ screen, url }` |
| `click`, `dblclick` | `{ screen, target }` |
| `drag` | `{ screen, from, to }` |
| `type` | `{ screen, target, text }` |
| `press` | `{ screen, key }` |
| `wait` | 밀리초 숫자 |
| `caption` | 자막 문자열 |
| `screen` | 화면 `id`. 자막을 표시할 화면을 바꾼다(처음에는 첫 화면) |
| `expect` | `{ screen, selector }`. 상태 확인 |
| `script` | JS 모듈 경로. `export default async (ctx) => ...`가 필요하고 `ctx.evaluate(screenId, fn, arg)`로 페이지 안에서 함수를 실행한다 |

기대 상태는 동작 옆에 `expect: { screen, selector }`로 적는다. 맞지 않으면 그 동작을 `retry`회 다시 실행하고, 그래도 안 되면 녹화가 실패로 끝난다. `retry`는 기본 `0`이며 `expect` 없이 쓸 수 없다.

`target`은 네 가지 형태다. 좌표는 쓰지 않고 녹화 중에 계산한다.

| 형태 | 예 |
|---|---|
| CSS selector 문자열 | `"h1"` |
| 문구 | `{ text: "Click me" }` |
| shadow DOM | `{ shadow: ["#host", "#inner"] }` |
| iframe 안 | `{ frame: "iframe#preview", target: "button" }` |

## 예시: 한 화면

```yaml
name: page-demo
caption:
  lang: en
  position: { page: bottom }
screens:
  - id: page
    url: http://127.0.0.1:5173/
    size: [1040, 760]
state:
  localStorage: ["app:*"]
mask: ["#user-email"]
steps:
  - caption: "Open the app"
  - click: { screen: page, target: "h1" }
    expect: { screen: page, selector: "h1" }
    retry: 2
  - caption: "Fill in the form"
  - type: { screen: page, target: "input[name=title]", text: "Hello" }
  - press: { screen: page, key: Enter }
  - wait: 800
```

## 예시: 페이지와 확장 사이드 패널

```yaml
name: ext-demo
caption:
  lang: en
  position: { page: bottom }
screens:
  - id: page
    url: http://127.0.0.1:5173/
    size: [1040, 760]
  - id: panel
    extension: { name: my-extension, path: ../extension, pinTo: page }
    size: [360, 760]
layout: { direction: horizontal, border: 2 }
state:
  chromeStorage: ["settings*"]
steps:
  - caption: "Open the panel"
  - click: { screen: panel, target: "#dock-button" }
    expect: { screen: panel, selector: "[data-dock='210']" }
    retry: 2
```

`script` 단계의 JS 파일 경로는 시나리오 파일 기준이고, 파일이 없으면 `validate`가 실패한다. 저장소의 `examples/scenarios/`에 동작하는 예시 시나리오가 있다.
