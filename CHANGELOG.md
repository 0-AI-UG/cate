# Changelog

All notable changes to Cate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-04-21

First minor release since the open-source drop. Major focus: unified **Spotlight-style overlays** (command palette, canvas-wide search, panel switcher, saved layouts, MCP editor), **startup resilience** (shell fallback, git-monitor crash, crash-report loop), and a handful of long-standing papercuts.

### Added

- **Canvas-wide search** (`Cmd+Shift+F`) — Spotlight-style multi-source search across workspace files, live terminal scrollback, and open panel titles/paths. Recent-focus ranking (the currently-focused panel always wins), colored type-tile icons per result, inline section dividers. Shortcut is intercepted in the capture phase so it works from inside Monaco and xterm. `toggleFileExplorer` moved to `Cmd+Shift+X` to clear the collision.
- **Saved Layouts manager** — in-app modal (`Cmd+K → "Saved Layouts…"`) for naming, saving, loading, and deleting canvas arrangements (nodes, regions, zoom, viewport). Stored in electron-store; replaces the old `window.prompt` / native "Save As…" dialogs. Matches the search overlay's visual language.
- **Editor buffer persistence for scratch editors** — unsaved content in filePath-less editors survives canvas switches, workspace switches, and app restarts. Stored on the panel itself and round-tripped through the existing session save.
- **Editor tab breadcrumb** — thin strip above Monaco showing the workspace-relative path split into segments (`folder › folder › file.ts`). Hidden for diff mode and scratch editors; full absolute path in the tooltip.
- **Panel switcher (Cmd+E) includes dock-zone panels** — File Explorer, Git, Project List, and Canvas host panel appear alongside canvas nodes. Selecting a dock item reveals its zone (unhiding if collapsed) and activates the correct tab.
- **MCP server editor dialog** — modal for adding and editing `.mcp.json` entries with a full environment-variable key/value list, parsed-args preview, and an inline **Validate** button that spawns the server, probes `initialize`, and shows `serverInfo` + advertised capabilities (tools / resources / prompts / logging) + protocol version. Writes nothing to disk during validation so users can iterate safely.
- **Phase 3 orchestrator plan** committed under `.claude/plans/phase-3-orchestrator.md` so the roadmap travels with the code.

### Changed

- **Command palette, canvas-wide search, saved layouts, and MCP editor** now share one Spotlight-style chrome: `rounded-3xl`, bright `white/20` outline, `backdrop-blur-2xl`, integrated magnifying-glass icon, bolder input text, type-tinted circular icon tiles on each row, inset selection highlight. Three overlays, one visual language.
- **Panel switcher masonry** — replaced the horizontal-scrollbar strip with a centered wrapping grid. Tiles are uniform width (220 px) with heights following each node's real aspect ratio (clamped). Off-screen nodes get a type-tinted placeholder icon instead of a blank tile so every tile conveys what it represents.
- **Dock tab bar** — each tab now carries a type-colored icon (terminal / editor / browser / git / explorer / projects / canvas). Active tab gets a 2 px bright-blue top accent and `font-medium` label. Overflow is handled by flex-shrink + truncate — no more horizontal scrollbar on narrow nodes. Thin inter-tab dividers for rhythm.
- **MCP test probe** now returns server capabilities instead of discarding the `initialize` response — `MCPTestResult` includes `serverInfo`, advertised capability flags, and protocol version.
- `defaultShellPath` default flipped from `/bin/zsh` to `""` (auto-detect) — meaningful on Linux where `/bin/zsh` often isn't installed.

### Fixed

- **Crash-report dialog loop** — `"Cate crashed unexpectedly"` was popping up on every packaged-app launch because `tryUnlink` silently swallowed deletion failures, leaving the report on the pickup path for the next startup. Now atomically renames the pending report into the archive as the *first* step, before parsing or dialog. Cross-device rename falls back to copy+unlink; last-resort delete on failure; all `tryUnlink` failures now log. Renderer side also filters resource-load failures (no more `[object Event]` noise reports) and dev mode skips the dialog entirely.
- **Shell fallback with user-visible banner** — when `defaultShellPath` points at a missing or non-executable binary, terminals used to die instantly with a cryptic `execvp(3) failed.` New `resolveShell()` validates the configured path, falls back through a platform chain, and surfaces a yellow banner inside the PTY explaining what happened and where to fix it. Includes `shellResolver.test.ts` (12 tests) covering the fallback paths.
- **Git monitor crash on unregistered root** — session restore could race ahead of the main-process allowed-roots registration, causing `validateCwd` to throw inside an `ipcMain.on` handler. With no promise boundary, the throw escaped as an uncaught exception and Electron showed a fatal dialog. Now wrapped in try/catch — monitor just doesn't start for the affected workspace, recoverable by re-opening the folder.
- **Git panel stale branch list** — the monitor only emitted updates when the *current* branch or dirty flag changed, so `git branch -d foo` in an external terminal left the sidebar showing `foo` until the next remount. Now also tracks the full local branch list and emits on any membership change. Three poll calls now run in parallel via a small `runGit` wrapper.
- **Shortcut collision** — `Cmd+Shift+F` was bound to both `globalSearch` (new) and `toggleFileExplorer` (historical). The matcher returned `toggleFileExplorer` first, so the new overlay never opened. Moved file-explorer toggle to `Cmd+Shift+X`.
- **Saved-layouts load regressions** — `closeAllPanels` nuked the canvas host panel too, leaving a blank dock center; restored via `ensureCenterCanvas`. Sync calls to `createTerminal/createEditor/createBrowser` then raced ahead of the new canvas's React mount, so nodes landed on the disposed store; now `ensureCanvasOpsForPanel` + `setActiveCanvasPanelId` are called synchronously to anchor the new canvas before nodes are created.

### Internal

- 13 PRs across the release (#3–#5, #7–#15). One commit per feature on main via squash-merge. All commits follow conventional-commits formatting with why-not-what bodies.
- CI builds green across `ubuntu-latest`, `macos-latest`, `windows-latest` for every merged PR.

## [0.1.0] - 2026-03-29

Initial open-source release.

### Added

- Infinite zoomable canvas with pan and zoom controls
- Code editor panels powered by Monaco Editor
- Terminal panels with xterm.js and native PTY backend
- Browser panels for embedded web previews
- Git-aware file explorer sidebar
- Source control sidebar with diff views and worktree support
- AI chat panel with Claude integration
- Command palette for quick command access
- Configurable keyboard shortcuts
- Panel switcher (Cmd+E)
- Workspace session persistence
- Welcome page
- Dock system for panel management
- Dark theme with Tailwind CSS
