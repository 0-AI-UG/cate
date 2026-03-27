# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CanvasIDE is a desktop application that provides an infinite zoomable canvas where editor panels, terminal panels, and browser panels float spatially (similar to Figma/Miro, but for coding). Built with Electron + React + TypeScript, styled with Tailwind CSS.

## Build System

The Electron app lives at the project root. Uses **electron-vite** for bundling.

```bash
npm install        # install dependencies
npm run dev        # start dev server with hot reload
npm run build      # production build
```

There are no tests currently.

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
- **lucide-react** — icons
- **electron-store** — persistent settings

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

Three panel types in `src/renderer/panels/`:
- **EditorPanel** — Monaco Editor with syntax highlighting
- **TerminalPanel** — xterm.js terminal with WebGL renderer, backed by node-pty
- **BrowserPanel** — embedded webview

Each panel is wrapped in a `CanvasNode` component (`src/renderer/canvas/CanvasNode.tsx`) providing title bar, drag, resize, and close behavior.

### State Management

Zustand stores in `src/renderer/stores/`:
- **canvasStore** — nodes, zoom, viewport offset, focus state, layout
- **appStore** — workspaces, sidebar, project paths
- **settingsStore** — user preferences
- **shortcutStore** — keyboard shortcut bindings
- **statusStore** — status bar state
- **uiStore** — transient UI state (command palette, etc.)

Session persistence saves/restores workspace state as JSON via electron-store.

### Key Patterns

- **Functional React** with hooks for all logic
- **Zustand** for global state (no Redux/Context boilerplate)
- **Tailwind CSS** for styling
- **IPC** for all main↔renderer communication (filesystem, git, terminal, shell)
- Keyboard shortcuts via `useShortcuts` hook
- File explorer is git-aware (tracks file status)
