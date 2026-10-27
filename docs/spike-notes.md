# M0 확인 실험 결과 (T01)

## 런타임
- Node v26.12.1. `.ts` 파일을 빌드 없이 실행한다 (`node spike/runtime-check.ts`).
- TypeScript 7.0.2. 가정 A03과 달리 5.x로 내릴 필요가 없었다. `npx tsc --noEmit`이 `allowImportingTsExtensions`, `erasableSyntaxOnly`, `module/moduleResolution: nodenext`를 처리하고 exit 0이다.
- tsconfig에 `target: es2023`, `skipLibCheck: true`를 더했다 (계획 목록에 없는 옵션). include는 `bin, src, test, spike`이며 T01 시점에도 spike 입력이 있어 오류가 없다.
- 의존성: playwright ^1.64.1, yaml ^2.9.1, typescript ^7.0.2, @types/node ^26.6.5. Chromium 1248을 `npx playwright install chromium`으로 설치했다.

## Playwright 확장 로드
- 쓸 모드: new headless. `launchPersistentContext(mkdtemp 프로필, { channel: "chromium", headless: true, args })`.
- 필요한 인자: `--disable-extensions-except=<dir>`, `--load-extension=<dir>`. headed 대체 모드는 시도할 필요가 없었다.
- service worker 대기: `ctx.serviceWorkers()`가 비면 `waitForEvent("serviceworker")`. 확장 ID는 `new URL(sw.url()).host`로 얻었다. manifest name 비교는 쓰지 않았다(확장이 하나뿐이라 불필요).
- 두 페이지(`setContent` 대상 + `chrome-extension://<id>/panel.html?tab=1`)를 연 뒤 둘 다 `page.screenshot()`이 성공했다. 뒤쪽 대상 페이지의 스크린샷과 타이머도 정상이었다(300ms 대기 동안 `performance.now()` 302ms 증가, 배경색 계산값 정상).
- 뒤쪽 페이지 렌더링 옵션: `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`, `--disable-background-timer-throttling`를 넣어 통과했다. 플래그 없이도 같은 시험이 통과해 이 세 옵션이 필수라는 근거는 없다(가정 A05는 재현되지 않음). 안전 장치로 유지하되, 뒤쪽 페이지 프레임이 멈추는 현상이 T-후속에서 보이면 그때 원인을 따로 본다.
- 임시 프로필과 임시 확장 폴더는 finally에서 지운다. 사용자 프로필, `channel: "chrome"`, `connectOverCDP`는 쓰지 않았다.

## ego-browser (문서 근거만, 사용자 연결 허락 없음)
근거: `ego-browser skill` 출력(v2.1.0)을 파일로 받아 읽었다. `ego-browser nodejs`, `help()`, 연결 시험, taskSpace 생성은 하지 않았다.

문서로 확인한 사실:
- 실행은 `ego-browser nodejs`에 스크립트를 넘기는 방식이다. 호출마다 새 Node 프로세스이고 taskSpace, 탭, Page 라벨만 유지된다. 변수는 유지되지 않는다.
- 스크립트는 작업 디렉터리와 환경 변수를 상속하지 않는다. 절대 경로를 쓰고 입력 값은 스크립트에 직접 적어야 한다.
- 스크립트는 ESM이고 내장 모듈은 `await import("node:fs/promises")` 같은 동적 import로 쓴다.
- 포인터 동작(`click`, `mouse.click`, `mouse.move`, `mouse.wheel` 등)은 `label` 옵션을 받는다. 표시용 문구이며 다른 메서드는 `label`을 거부한다.
- `page.screenshot({ path })`의 path는 절대 경로여야 한다. 좌표는 CSS 픽셀이다.
- 한 목표에 taskSpace 하나를 쓰고 `taskSpace(name)`으로 같은 이름을 이어 쓴다. 끝날 때 `task.finish({ keep: [] })`를 한 번 호출한다.
- 화면 크기 고정 수단으로 문서에 명시된 것은 `page.cdp()`(Page, Runtime, DOM, Network, Input 등 허용)다. `Emulation.setDeviceMetricsOverride`가 통과하는지는 확인하지 못했다.
- 사용자가 개입하면 중단해야 하고 우회하지 않는다.

미확인(연결 허락 없음), 수동 확인 필요:
- `mouse.click`의 클릭 횟수 옵션(`clickCount`)과 `dblclick()` 대체 가능 여부. 문서는 uncommon options를 `help()`로 안내한다.
- `page.cdp("Emulation.setDeviceMetricsOverride")`로 화면 크기를 고정할 수 있는지.
- 프로세스 안에서 `node:net`으로 127.0.0.1에 연결할 수 있는지.
- 알림 줄 형식(`[ego-browser:notice]`는 최종 출력에 나온다는 것만 문서에 있음).
- `page.screenshot()`의 크기·형식 옵션, `page.cdp` 사용 가능 범위의 실제 동작.

## T10 방식 결정: 단계별 프로세스
브리지(녹화 한 번 동안 `ego-browser nodejs` 프로세스 하나 유지, 127.0.0.1 토큰 소켓)는 `node:net` 사용 가능 여부를 확인하지 못해 채택하지 않는다. 문서가 보장하는 "호출마다 새 프로세스, taskSpace와 Page 라벨만 유지" 모델에 맞춰 단계마다 `ego-browser nodejs`를 한 번 실행한다. 각 스크립트는 절대 경로와 값을 직접 박아 생성하고, 같은 taskSpace 이름을 재개하며, 마지막 단계에서 `finish`를 호출한다. 클릭 횟수와 화면 크기 고정은 T10에서 어댑터 능력으로 선언하고, 확인되지 않은 동작은 사용자가 허락한 뒤 수동으로 확인한다.

## ego-browser 수동 확인 (T10, 자동 시험 아님)
사용자 브라우저를 조작하므로 사용자 허락을 받은 뒤에만 실행한다. 자동 시험은 `test/fixtures/fake-ego-browser.ts`만 쓴다.

```
node examples/fixture-app/serve.ts --port 5173
node bin/reel-mesh.ts record examples/scenarios/fixture-app.yaml --adapter ego-browser
```

확인할 것:
- `page.cdp("Emulation.setDeviceMetricsOverride")`가 거부되지 않고 화면 크기가 800x600으로 고정되는지.
- `page.cdp("Input.dispatchMouseEvent")`에 `clickCount: 2`를 주면 더블클릭으로 동작하는지.
- `page.screenshot({ path })`가 PNG를 쓰는지, ego-browser의 에이전트 커서가 프레임에 찍히는지.
- 녹화가 끝난 뒤 녹화가 만든 탭만 닫히고 사용자의 기존 탭이 남아 있는지, localStorage `fixture:*`가 원래 값으로 복원되는지(`.reel/fixture-app/state-restore.json`).
- 알림 줄 형식. 어댑터는 `[ego-browser:`로 시작하는 줄을 알림으로 보고, `[ego-browser:notice]`가 있으면 녹화 끝에 한 줄로 알린다.

`check --adapter ego-browser`는 지원하지 않는다(`src/precheck.ts`가 Playwright 어댑터로 고정). ego-browser 녹화는 사전 점검 없이 시작한다.
