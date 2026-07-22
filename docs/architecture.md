# Architecture

```text
src/
├── agent/      # Embedded Pi coding-agent: process manager, auth, marketplace, panel UI
├── cli/        # The `cate` CLI available inside Cate terminals (browser control, panels, editor)
├── main/       # Electron main process: IPC, workspaces, windows, updater, security
├── preload/    # Context-isolated IPC bridge
├── renderer/   # React 18 app: canvas, docking, panels, sidebar, stores, hooks
├── runtime/    # Runtime daemon for remote (SSH) workspaces: terminals, agents, search
└── shared/     # IPC channels and shared types
```

See [`CLAUDE.md`](../CLAUDE.md) for detailed guidance on the codebase: coordinate system, panel system, state stores, and persisted state.

## Security model

Cate runs all IPC through a context-isolated preload bridge. Filesystem access is scoped to registered workspace roots, browser panels disable node integration, and terminals can't spawn outside approved directories.

The `cate` CLI is gated per surface in Settings → CLI, separately for Read and Control.

## Agent terminals

Cate hooks the agent CLIs it supports (Claude Code, Codex, Cursor, Grok, OpenCode, Pi) so the agent itself reports turn start, turn end, and permission prompts. That drives the panel's running / waiting / finished state and the notification when one needs an answer. An agent that posts no hooks shows no status.

The hook stream also carries each CLI's session id, which is what makes a terminal resumable across restarts. A stale id falls back to a plain shell rather than resuming the wrong conversation.

Worktree colors follow a branch through the sidebar, dock tabs, and the territory drawn behind its panels on the canvas.

## Stack

Electron 41, React 18, Zustand 5, Monaco 0.52, xterm.js 5.5 + node-pty 1.0, Tailwind 3.4, electron-vite, electron-builder, electron-updater, Sentry. PDFs and DOCX via pdf.js and mammoth, git via simple-git, file watching via `@parcel/watcher` and chokidar. The embedded coding agent is built on `@earendil-works/pi`, shipped as an on-demand runtime alongside the app.
