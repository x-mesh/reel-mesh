# reel-mesh

[한국어](README.ko.md) | English

reel-mesh records demo GIFs for the README of a web project. You write a scenario file in YAML that lists clicks, typed text, and captions step by step. reel-mesh opens a browser, takes a screenshot at each step, and joins the screenshots into a GIF. The scenario stays in your repository. When a feature changes, the same command makes a new video with the same length.

reel-mesh can capture web apps, static HTML pages, and the side panel of a Chrome extension. It can also put two screens side by side in one video, for example a page and a panel. Screen capture does not show the real pointer. Thus reel-mesh draws a pointer, click marks, and captions on the page before each screenshot.

The repository also contains a skill for AI coding agents. With the skill, an agent reads your project and suggests demo candidates. Then it records the candidate that you select and adds the GIF to the README. You can install the skill in Claude Code, Codex, Cursor, Kiro, Antigravity, and OpenCode.

## Install

Node.js and `ffmpeg` must be on your PATH. Node.js runs the TypeScript files without a build step. The tests ran on Node.js v26.12.1 and `ffmpeg` 9.0.2.

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash
```

The install script does these steps:

1. It downloads the repository to `~/.local/share/reel-mesh`. Then it runs `npm ci --omit=dev` and `npx playwright install chromium`.
2. It makes the `~/.local/bin/reel-mesh` command. If that folder is not on your PATH, the script tells you to add it.
3. It finds the AI coding tools on this computer and shows them. After you confirm, it registers the skill. To register without a prompt, add `bash -s -- --yes`.

| Tool | Detected by | Installs to |
|---|---|---|
| Claude Code | `claude` command | Adds `~/plugins/reel-mesh` as a local marketplace and runs `claude plugin install reel-mesh@reel-mesh -s user` |
| Codex | `codex` command | Adds `~/plugins/reel-mesh` to `~/.agents/plugins/marketplace.json` and runs `codex plugin add reel-mesh@<marketplace name>` |
| Cursor | `~/.cursor` | `~/.cursor/skills/reel-mesh/` |
| Kiro | `~/.kiro` | `~/.kiro/steering/reel-mesh*.md` |
| Antigravity | `~/.gemini` | `~/.gemini/antigravity/skills/reel-mesh.md` and a reel-mesh block in `~/.gemini/AGENTS.md` |
| OpenCode | `~/.config/opencode` or the `opencode` command | `~/.config/opencode/skills/reel-mesh/SKILL.md` |

After the registration, start a new session in each tool to load the skill.

To select the tools yourself, or to register the skill again later, use the installed CLI. The CLI does not overwrite a file that it did not create. Add `--force` to overwrite such a file.

```bash
reel-mesh setup install --targets codex,cursor --yes   # without --targets: all detected tools
reel-mesh setup status
reel-mesh setup uninstall --yes
```

To remove everything, run the install script with `uninstall`. It removes the registered skill, the `reel-mesh` command, and `~/.local/share/reel-mesh`.

```bash
curl -fsSL https://raw.githubusercontent.com/x-mesh/reel-mesh/main/scripts/install.sh | bash -s -- uninstall
```

If you use only Claude Code, you can install the skill as a plugin. The skill still needs the `reel-mesh` command to record, so run the install script too.

```text
/plugin install reel-mesh --marketplace x-mesh/reel-mesh
```

## First run

The installed folder contains a test app. Use it to make your first GIF. Start the test app server in a second terminal.

```bash
cd ~/.local/share/reel-mesh
node examples/fixture-app/serve.ts --port 5173
```

Run these commands in the same folder, in this order.

```bash
cd ~/.local/share/reel-mesh
reel-mesh check examples/scenarios/fixture-app.yaml
reel-mesh record examples/scenarios/fixture-app.yaml
reel-mesh review examples/scenarios/fixture-app.yaml
reel-mesh render examples/scenarios/fixture-app.yaml
```

The commands write their output to `.reel/fixture-app/` in the current folder.

- `frames/`, `frames.json`: the frames of each step and the display time of each frame
- `run.log`: step names, times, and frame counts
- `review/contact-sheet.png`, `review/step-<n>.png`: a contact sheet for review and the last frame of each step
- `fixture-app.gif`: the GIF

`examples/scenarios/fixture-ext.yaml` captures a page and an extension side panel together. Keep the same server and change only the scenario path in the commands above. The result is a 1402×760 GIF.

## Scenario

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

A target is a CSS selector or a text, not a coordinate. reel-mesh calculates the coordinates while `record` runs. Thus a new screen size does not require a change to the scenario.

Add `expect` to an action step to set the expected state. If the page does not match it, reel-mesh runs the action again, up to `retry` times. If the page still does not match, `record` stops with an error. A wrong screen never goes into the GIF.

The time values in the scenario set the speed of the video. The real capture time has no effect. Two runs of `record` on the same scenario give the same frame count and the same length.

For all fields and their defaults, see [skills/reel-mesh/references/scenario-format.md](skills/reel-mesh/references/scenario-format.md) (Korean).

## Commands

| Command | What it does |
|---|---|
| `validate <scenario>` | Checks the scenario syntax. It does not open a browser. |
| `check <scenario> [--adapter]` | Checks ffmpeg, the dev server, the browser, the extension, and the first target element. If a check fails, it shows the next action in one line. |
| `record <scenario> [--adapter]` | Runs the checks. If they pass, it captures every screen at each step. |
| `restore <scenario> [--adapter]` | Puts back the browser state from the snapshot that `record` left. |
| `review <scenario>` | Makes a contact sheet and the last frame of each step. |
| `render <scenario> [--width <px>] [--colors <n>] [--budget-mb <n>] [--mp4 [path]]` | Makes a GIF, and an MP4 if you ask for it. If the GIF is larger than the size budget, it suggests a command with a smaller width and fewer colors. |
| `audit <scenario> --deny-file <path>` | Searches the scenario and the output text files for denied strings. |

Run each command as `reel-mesh <command>`. Run a command without arguments to see its usage. `reel-mesh setup` registers the skill (see [Install](#install)).

| Exit code | Description |
|---|---|
| 1 | The run failed. |
| 2 | The scenario or an argument is not valid. |
| 3 | A check before the record step failed. |
| 4 | After the restore, the stored values differ from the values before `record`. |
| 5 | A snapshot from a previous run remains. |
| 6 | The audit found a denied string. |

## Browser state

You can list `localStorage` keys or extension `chrome.storage` keys in the `state` field of a scenario. Before it captures the first frame, `record` saves their values to `.reel/<name>/state-snapshot.json` and clears them. Thus each run starts from a clean state.

After the run, `record` puts the saved values back, also when the run fails. It compares them with the values from before the run and writes the result to `state-restore.json`. If the process stops by force and the snapshot remains, the next `record` does not start. It tells you to run `restore`.

## Browser adapters

- `playwright` (default): starts a new Chromium with a temporary profile. It does not touch your browser. It supports extension screens.
- `ego-browser`: controls the browser that you use. It does not support extension screens. Only a fake executable tested this adapter, so its behavior with the real ego-browser is not known. [docs/spike-notes.md](docs/spike-notes.md) (Korean) lists the items to check and the commands.

Only the adapter that made a snapshot can restore it. If you run `restore` with another adapter, it exits with code 2 and shows the correct command.

## AI agent skill

[skills/reel-mesh/SKILL.md](skills/reel-mesh/SKILL.md) is the procedure for the agent. The skill text is in Korean. The agent selects demo candidates, writes a scenario, records it, reviews the frames, makes a GIF, and adds the GIF to the README. It asks you two questions. The first question is which candidate to record. The second question is whether the GIF is acceptable before it goes into the README.

The agent runs `reel-mesh` from the root of the target project, so `.reel/` is in that project. The skill tells the agent to add `.reel/` to the `.gitignore` of that project. If the `reel-mesh` command is not available, the agent does not record. It shows the install command.

## Limitations

- reel-mesh does not record sound, the OS screen, desktop apps outside the browser, or video edits.
- `audit` does not read text in images. Hide personal data on the screen with `mask` in the scenario, and examine the images during the review.
- `mask` finds elements only in the top-level document. It cannot hide elements in an iframe or a shadow DOM.
- To find an extension by its name, the extension must have a background service worker.

## Development

To run reel-mesh from the repository, install the dependencies and run `node bin/reel-mesh.ts <command>`. If you run `scripts/install.sh` from the repository, it installs that checkout instead of the GitHub version.

```bash
npm i
npx playwright install chromium
npm test
npm run typecheck
```

`npm test` runs the tests in order, with the browser tests. It takes about 2 minutes.

## License

[MIT](LICENSE)
