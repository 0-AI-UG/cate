# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cate is a desktop application that provides an infinite zoomable canvas where editor panels, terminal panels, and browser panels float spatially (similar to Figma/Miro, but for coding). Built with Electron + React + TypeScript, styled with Tailwind CSS.

## Build System

The Electron app lives at the project root. Uses **electron-vite** for bundling.

```bash
npm install        # install dependencies
npm run dev        # start dev server with hot reload
npm run build      # production build
npm test           # run vitest suite
```

Tests use **Vitest** and live alongside the code they cover (`*.test.ts` / `*.test.tsx`). A few git-touching tests assume a clean working repo and may fail when the dev tree has a branch named `main` or local modifications — those failures are environmental, not regressions.

## Dependencies

Managed via npm (`package.json`):
- **Electron** — desktop shell (Chromium + Node.js)
- **React 18** + **react-dom** — UI framework
- **xterm.js** (`@xterm/xterm`) — terminal emulator with WebGL addon
- **node-pty** — native PTY for terminal backend
- **Monaco Editor** — code editor (VS Code's editor component)
- **zustand** — lightweight state management
- **chokidar** — filesystem watching
- **simple-git** — git operations
- **@phosphor-icons/react** — icons
- **electron-updater** — auto-update (GitHub Releases)

## Architecture

### Process Model (Electron)

- **Main process** (`src/main/`) — window management, IPC handlers, native APIs
- **Preload** (`src/preload/`) — secure bridge exposing IPC to renderer
- **Renderer** (`src/renderer/`) — React app with canvas UI

IPC channels are defined in `src/shared/ipc-channels.ts`. Type definitions in `src/shared/types.ts`.

### Coordinate System & Canvas

The canvas (`Canvas.tsx`) positions nodes using CSS transforms. Panel positions are stored in **canvas-space** and converted to **view-space** via zoom level and viewport offset. Key conversions in `src/renderer/lib/coordinates.ts`: `canvasToView()` / `viewToCanvas()`. Zoom range defined by `ZOOM_MIN`/`ZOOM_MAX` in shared types.

### Canvas Interaction

`useCanvasInteraction` hook handles wheel events (Cmd+scroll = zoom, two-finger = pan) and right-click drag panning. Node drag/resize handled by `useNodeDrag` and `useNodeResize` hooks.

### Panel System

Panel definitions are centralised in `src/shared/panels.ts`. The detachable panel
types (`PanelType` in `src/shared/types.ts`) are: terminal, browser, editor,
canvas, agent, document. Renderer components live in `src/renderer/panels/`:
- **EditorPanel** — Monaco Editor with syntax highlighting
- **TerminalPanel** — xterm.js terminal with WebGL renderer, backed by node-pty
- **BrowserPanel** — embedded webview (file:// allowed for local HTML)
- **CanvasPanel** — nested canvas
- **DocumentPanel** — PDF / docx preview
- **AgentPanel** — Claude-Code agent thread (sidebar + dock)

The file tree (`src/renderer/sidebar/FileExplorer.tsx`) and recent-projects
switcher (`src/renderer/sidebar/ProjectList.tsx`) are **sidebar** components, not
detachable panels.

Each panel can be wrapped in a `CanvasNode` (`src/renderer/canvas/CanvasNode.tsx`) — title bar, drag, resize, close — or live inside a dock zone via `DockTabStack` (`src/renderer/docking/`). Detached panel/dock windows have their own shells (`src/renderer/shells/PanelWindowShell.tsx`, `DockWindowShell.tsx`) with local panels state synced back to main for session persistence.

### State Management

Zustand stores in `src/renderer/stores/`:
- **canvasStore** — nodes, regions, zoom, viewport offset, focus state, history; per-canvas instances created via `CanvasStoreContext`. A `focusEpoch` counter lets panels re-run focus side effects when the same node is re-focused.
- **appStore** — workspaces, panels, selected workspace, sidebar
- **dockStore** — dock-zone layout (per window)
- **settingsStore** — user preferences
- **shortcutStore** — keyboard shortcut bindings
- **statusStore** — status bar state
- **uiStore** — transient UI state (command palette, etc.)
- **updateStore** — auto-updater status pushed from main
- **urlPromptStore** — pending URL-open confirmations from terminals

Persisted state is stored as hand-editable JSON files under `userData` (no
electron-store). `settingsFile.ts` owns `settings.json`; `jsonStateFile.ts` is a
reusable factory for that same pattern (sync load, in-memory authority, debounced
atomic write, chokidar external-edit watcher, corrupt-file quarantine).
`workspaceStateStore.ts` uses it for `recent-projects.json`, `sidebar.json`,
`remote-workspaces.json`, and `layouts.json`. Per-project canvas/session state
lives in `<project>/.cate/workspace.json` + `session.json`. AI provider credentials are
global in `userData/pi-agent/auth.json` (+ `models.json`), mirrored into each
workspace's `.cate/pi-agent/`.

### Key Patterns

- **Functional React** with hooks for all logic
- **Zustand** for global state (no Redux/Context boilerplate)
- **Tailwind CSS** for styling
- **IPC** for all main↔renderer communication (filesystem, git, terminal, shell)
- Keyboard shortcuts via `useShortcuts` hook
- File explorer is git-aware (tracks file status)
