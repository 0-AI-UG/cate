---
name: run-cate
description: >-
  Build, launch, and drive the Cate Electron desktop app for an agent — take
  screenshots, click UI, seed canvas panels, and run JS in the renderer via a
  Playwright REPL driver. Use this whenever you need to actually run Cate (not
  just the tests): to screenshot the app, verify a UI change in the real window,
  confirm a fix works end-to-end, reproduce a bug, or capture before/after
  visuals on different themes. Prefer this over rediscovering the launch recipe —
  it captures the env flags, the first-run modal, and the test harness that make
  a headless launch actually work.
---

# Running the Cate app

Cate is an Electron desktop app (infinite zoomable canvas of editor/terminal/
browser panels). It has a window, so a headless agent drives it through
Playwright's `_electron` API. This skill ships a REPL driver — launch the app
once, then send one command per line. Screenshots are how you "see" it: a blank
frame means the launch failed, so always look at the PNG.

All paths below are relative to the repo root.

## Build first

Playwright launches the **built** app (`main: dist/main/index.js`), not the dev
server. Build before launching, and after any change to `src/`:

```bash
npm install        # once
npm run build      # outputs dist/ — rerun after editing src/
```

## Run (the driver)

The driver lives at `.claude/skills/run-cate/driver.mjs` and drives two ways.

### One-shot (portable — no tmux). Each arg is one command, run in order

This is the quickest path and works anywhere Node + Playwright do. The app is
closed automatically at the end:

```bash
node .claude/skills/run-cate/driver.mjs launch 'size 1000 1400' 'ss landing' quit
```

Then **open the PNG** (default dir `/tmp/cate-shots/`, override with
`SCREENSHOT_DIR`) and confirm it's the app, not a blank/login/splash frame.

Chain whatever you need:

```bash
node .claude/skills/run-cate/driver.mjs \
  launch 'size 1000 1400' \
  'seed-terminal 260 120' \
  'eval () => window.__cateE2E.nodes().length' \
  'ss canvas' quit
```

### Interactive REPL (for multi-turn poking; use tmux if available)

Run with no args to get a `driver>` prompt that stays up between commands:

```bash
tmux new-session -d -s cate -x 220 -y 50
tmux send-keys -t cate 'node .claude/skills/run-cate/driver.mjs' Enter
timeout 20 bash -c 'until tmux capture-pane -t cate -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t cate 'launch' Enter
timeout 60 bash -c 'until tmux capture-pane -t cate -p | grep -q "launched"; do sleep 0.3; done'
tmux send-keys -t cate 'ss landing' Enter
tmux capture-pane -t cate -p | tail -5
```

On Linux/headless prefix the node command with `xvfb-run -a` and
`apt-get install -y xvfb libnss3 libgbm1 libasound2t64 libgtk-3-0 libxss1 libxkbcommon0 libatk-bridge2.0-0 libcups2 libdrm2`.

### Commands

| command | what it does |
|---|---|
| `launch` | launch the app, wait for `window.__cateE2E.ready`, auto-dismiss the welcome modal |
| `size <w> <h>` | resize + center the main window (do this before screenshots) |
| `ss [name]` | screenshot the whole window → `$SCREENSHOT_DIR/<name>.png` |
| `ss-sel <css> [name]` | screenshot one element by selector (e.g. `ss-sel .prose-markdown preview`) |
| `click <css>` | DOM `.click()` an element (robust vs canvas coordinate math) |
| `click-text <text>` | click the button/link/role=button whose text matches |
| `type <text>` / `press <key>` | keyboard input (`press Meta+KeyK`, `press Escape`, …) |
| `eval <js>` | run JS in the renderer, print the JSON result (escape hatch) |
| `text [css]` | print `innerText` of an element (or the whole body) |
| `nodes` | list canvas nodes the harness knows (id/panelId/origin/size) |
| `seed-terminal [x y]` / `seed-canvas [x y]` | drop a fresh panel on the canvas |
| `dismiss` | re-dismiss the welcome modal if it reappears |
| `windows` | list open window URLs |
| `quit` | close the app and exit the driver |

## Reaching into the app (the test harness)

Launching with `CATE_E2E=1` installs `window.__cateE2E` (see
`src/renderer/lib/e2eHarness.ts`) — store-level helpers that are far more
reliable than driving the canvas by mouse: `nodes()`, `createTerminal(point)`,
`createCanvasPanel(point)`, `zoom()/setZoom()`, `resetViewport()`,
`terminalPtyId()/writeTerminal()`, `dragSnapshot()`. Reach them through `eval`:

```
eval () => window.__cateE2E.nodes()
```

The full preload bridge is also reachable as `window.electronAPI` (e.g.
`window.electronAPI.fsReadFile(path)`). For flows the harness doesn't expose yet
(e.g. switching theme, opening a markdown preview), the clean way is to add a
small `CATE_E2E`-gated helper to `e2eHarness.ts` rather than scripting brittle
clicks — that file is the intended seam for exactly this.

## Why the launch flags matter (gotchas)

- **`electron.launch({ args: ['.'], cwd: <repo> })` with no `executablePath`.**
  Playwright resolves the electron binary from the repo's `node_modules`, so the
  same call works on macOS and Linux. Mirrors `e2e/fixtures/electron-app.ts`.
- **`CATE_E2E=1`** points `userData` at a fresh tmpdir per launch — your real
  session/workspaces are never touched — *and* installs `window.__cateE2E`.
  Because the profile is fresh, the canvas starts empty (seed it).
- **First-run "Welcome to Cate" modal.** A fresh profile always shows it
  (`PostUpdateFeedbackDialog`), and it re-pulls at ~4s and ~8s. The driver
  dismisses it via `window.electronAPI.dismissFeedback('close')` (clears the
  pending state so the re-pulls stop) plus a poll-click on "Close". If it
  reappears mid-session, run `dismiss`.
- **`CATE_DISABLE_TRUST_SCOPING=1`** (dev-only; a no-op once packaged) restores
  `$HOME` as an allowed `fsReadFile` root. Without it, opening a file that isn't
  inside an opened project is denied ("path is outside allowed directories"), so
  put any sample files you want to open under `$HOME` and keep this flag on.
- **Slow/async loads.** Wait on `window.__cateE2E.ready`, not a fixed sleep. When
  opening a file editor, Monaco loads the file asynchronously — let it settle
  before reading the model / toggling preview, or you'll capture an empty state.

## Troubleshooting

- **Launch timeout / `__cateE2E` never ready:** `dist/` missing or stale → rerun
  `npm run build`. Confirm `main` in `package.json` points at `dist/main/index.js`.
- **Blank screenshot:** the window painted nothing — usually a renderer crash;
  run `windows` and `text body` to inspect, check the tmux pane for errors.
- **`fsReadFile` "Access denied":** file is outside the allowed roots → move it
  under `$HOME` and launch with `CATE_DISABLE_TRUST_SCOPING=1` (the driver sets it).
- **"Missing X server" (Linux):** you forgot `xvfb-run -a`.
- **Stale Xvfb locks (Linux):** `rm -f /tmp/.X*-lock; pkill Xvfb`.
- **Driver seems hung:** Electron is slow to launch (~3-6s) and `launch` waits up
  to 30s for readiness — give it time before assuming failure.
