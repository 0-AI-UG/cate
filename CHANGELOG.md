# Changelog

All notable changes to Cate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.6] - 2026-06-09

Bug-fix release for terminals detached into their own window.

### Fixed

- **Detached terminals no longer render blank or grey**: the GPU renderer now rebuilds and repaints once the new window is actually shown, instead of staying empty until the next output.
- **Detached terminal scrollback keeps its formatting**: replayed history is written with proper line breaks, so multi-column output (like `ls`) lines up again instead of cascading down the screen.

## [1.1.1] - 2026-06-01

Polish release: grid snapping on the canvas, steadier sidebar and window handling, a big batch of new editor themes, and opt-in usage analytics for agent messages.

### Added

- **Snap to grid**: windows snap to a grid as you drag them on the canvas, so they line up cleanly without manual nudging. (#165)
- **Sidebar memory and tab menu**: the sidebar remembers its tab order and the active workspace, and a right-click menu lets you rename or close a tab. (#225, #193)
- **Custom OpenAI-compatible endpoint**: point the agent at your own provider through a configurable endpoint. (#203)
- **Theme-aware window chrome**: native window chrome follows the active theme, with a new Dark Cold default. (#190)
- **Git decorations in the file tree**: VS Code-style status colors so you can read a file's git state at a glance. (#205)
- **More terminal controls**: a text-contrast setting and an Option-as-Meta toggle for macOS keyboards. (#206, #192)
- **New themes**: Clay Light and Clay Dark, plus Visual Studio Light and Dark, the One Dark Pro family, and One Light. (#210, #196)
- **One .cate gitignore**: a single `.cate/.gitignore` now covers session, agent, and worktree files. (#218)
- **Usage analytics for agent messages**: anonymous, opt-in tracking of how many messages are sent to agents. It records only the message kind, its length, and whether images were attached, never the message text, and you can turn it off in settings. (#244)

### Changed

- **Markdown preview follows the theme**: the preview now matches whichever theme is active. (#208)
- **Lighter idle cost**: idle terminals use less CPU and per-frame canvas culling is cheaper. (#201)
- **Shared window focus helper**: window restore and focus logic now lives in one place. (#230)
- **Removed legacy canvas panels**: dropped the obsolete git, file explorer, and project list canvas panels. (#226)

### Fixed

- **Deferred workspace activation**: activating a deferred workspace no longer wipes the canvas, and browser logins persist across sessions. (#220, #235)
- **Chat scroll position**: the agent chat keeps its place across refocus, with a new scroll-to-bottom button. (#233)
- **Shared-project reload loop**: two copies of Cate open on the same project no longer loop on reload. (#229)
- **Empty file tree on new workspaces**: the explorer retries its initial load, and nested folders refresh to match disk. (#212, #219)
- **Popover position and selectable replies**: chat input popovers stay correctly placed at any zoom, and chat replies can be selected. (#199, #189)
- **Terminal scroll and file drop**: the terminal keeps its scroll position across dock-tab switches, and external file drops insert a path again. (#202, #200)
- **Hand tool**: the Hand tool is fully inert, showing a grab cursor without firing clicks. (#207)
- **Sidebar polish**: header alignment, multi-select and delete, and scrollbar fixes. (#242)
- **Packaged builds**: the gh CLI resolves through the shell environment, and the subagent extension ships in packaged builds. (#198, #197)
- **Running-title shimmer**: stays white over worktree colors. (#234)

## [1.1.0] - 2026-05-29

Feature release: unified theming, a redesigned parallel-work flow, clickable terminal links, and configurable file exclusions.

### Added

- **Unified theming**: a single data-driven theme system covering app chrome, the terminal ANSI palette, and Monaco editor syntax tokens, alongside canvas tools, spatial navigation, and command palette polish. (#174)
- **Configurable file exclusions**: a new **File Explorer** settings section lets you edit the list of folder/file names hidden from the file explorer, file search, and change watching. The list persists across sessions, applies to every project, and updates open explorers live without a relaunch. Includes a "Restore defaults" action. (#155)
- **Redesigned parallel work**: a reworked tab, drag-to-canvas, PR support, and worktrees stored in `.cate`. (#182)
- **Open file paths from the terminal**: Cmd+Click a file path in the terminal to open it in the editor. (#180)
- **Clickable terminal links**: links in the terminal are now clickable, with a dialog to choose where to open them. (#178)
- **Close tab on middle-click**: middle-clicking a tab closes it. (#176)
- **Reload workspace from disk**: the `.cate` skill can configure the IDE, with a reload-from-disk action. (#170)
- **Per-workspace pi agent config**: pi agent configuration is scoped per workspace, with accordion provider settings. (#168)
- **Terminal scroll-speed setting**: a new setting controls xterm scroll sensitivity. (#185)

### Changed

- **Trimmed default file exclusions**: `dist` and `build` are no longer hidden by default. They are common names for hand-written source and config, and the previous exact-name match could silently hide files you wanted to see. The remaining defaults are unchanged: `.git`, `.DS_Store`, `.Trash`, `node_modules`, `__pycache__`, `.npm`, `.cache`, `.build`, `.swiftpm`, `DerivedData`, `Pods`. (#155)
- **UI polish**: squared top-level and nested cards, de-blued and softened pane glow, and calmer active-tab and terminal highlights. (#181, #179)
- **Performance tooling**: added a profiler and stress harness, and fixed zoom re-renders and terminal log I/O. (#173)

### Fixed

- **Markdown preview reset**: switching files now resets the markdown preview. (#186)
- **macOS line-editing chords**: line-editing chords are now delivered to the shell. (#177)
- **Split-terminal divider**: the divider no longer jumps on resize. (#171)
- **Terminal scroll under resize strips**: terminal scroll and scrollbar keep working under resize strips. (#160)
- **Drag and drop**: fixed canvas/workspace drag and drop and the empty-workspace note blink. (#166)
- **Terminal CPU usage**: cut sustained CPU and WindowServer usage from terminals. (#161)
- **Parallel-work title tint**: tint the title text rather than the icon. (#169)

## [1.0.4] - 2026-05-28

Patch release focused on agent process detection, parallel-work ergonomics, and a critical packaging fix for extension installs.

### Added

- **Broader agent detection**: the terminal now recognizes more coding agents as running, including Antigravity CLI, Forge Code, and node-script based agents (detected via `ps -o args`), in addition to the existing set.
- **Agent-aware terminal tabs**: terminal tabs running an agent show a dedicated icon and title, plus an awaiting-input dot when the agent is waiting on you.
- **Choose any base branch for worktrees**: when creating a new worktree for parallel work, you can now select any branch as the base instead of being limited to the default.
- **Project-local workspace state**: workspace layout is now stored in a `.cate/` directory inside the project, so canvas state travels with the repository.
- **Rename any panel from the tab menu**: the tab context menu gains a Rename action that works for all panel types, including panels in detached dock windows.
- **Unified accent palette**: workspaces and canvas regions now share a single consistent accent color palette.
- **Multilingual README**: added French, Simplified Chinese, and German translations of the README.

### Changed

- **Search folded into the command palette**: `Cmd+Shift+F` search is consolidated into the `Cmd+K` palette, giving one entry point for find and commands.
- **More reliable agent running state**: the agent's running indicator is now derived from PTY output streaming and the agent's own spinner, rather than brittle process heuristics, so it reflects activity more accurately.
- **Docs**: noted the deprecation of the Gemini CLI in favor of Antigravity.

### Fixed

- **Extension install crash in the packaged app**: installing an extension no longer fails with `ERR_MODULE_NOT_FOUND` (e.g. `cross-spawn`). The pi coding agent's full dependency tree is now unpacked from the asar so its modules resolve on disk regardless of npm's hoisting layout. (#150)
- **New Terminal worktree submenu**: the submenu now reflects the live git worktree list instead of a stale snapshot. (#145)
- **Forgiving resize hitbox**: floating panels are easier to grab and resize from their edges. (#147)
- **Dismissed terminal URLs stay dismissed**: URLs you dismiss from a terminal are no longer re-queued for confirmation. (#138)
- **Parallel tool-call shimmer**: all parallel agent tool calls now shimmer during the loading gap, not just the first. (#133)
- **Ctrl+C in terminal on Windows/Linux**: copies the selected text when there is a selection instead of always sending SIGINT. (#125)
- **Tab bar cursors**: clearer cursor feedback on the canvas-node tab bar. (#120)
- **Drag release tracking**: the window blur listener is bound in the bubble phase so drags end cleanly when focus leaves the window. (#119)

## [1.0.3] - 2026-05-26

Patch release with Save-As for untitled editors, agent panel visual polish, and session persistence fixes.

### Added

- **Save-As for untitled editor buffers** — `Cmd+S` on a scratch editor opens a native Save-As dialog; subsequent saves reuse the chosen path. The close-confirm dialog's "Save" button also triggers Save-As for untitled buffers, and cancelling the picker keeps the panel open.
- **Per-window file grants** — files saved via Save-As outside the workspace are granted persistent read/write access scoped per window, surviving app restarts without widening the sandbox.

### Changed

- **Agent chat thread polish** — loading states with shimmer animation, smooth auto-scroll, and fade-in transitions for new messages.
- **Agent user message styling** — softer bubble background and text contrast for user messages; removed hover color override on thinking blocks.

### Fixed

- **Agent node session persistence** — agent panels now persist and restore correctly across app restarts.
- **Close-confirm dialog detail** — shows the on-disk path for a single dirty file, or a "Save will prompt for a location" hint for untitled buffers.
- **Save routing** — `Cmd+S` routes to the editor that most recently held Monaco text focus, not whichever editor passes `hasTextFocus()` at the key event.
- **Detached window Save-As sync** — Save-As in dock or panel windows syncs the new file path back to main for session persistence.

## [1.0.2] - 2026-05-26

Patch release with agent panel UI polish and minimap improvements.

### Added

- **Minimap click-to-focus** — clicking a node in the minimap now focuses and centers it on the canvas.
- **Browser panel local file support** — `file://` URLs and absolute local paths are now supported in browser panels.

### Changed

- **Agent chat thread redesign** — tool cards use a cleaner inline layout: bash commands show as compact single-line entries, diffs render with line numbers and colored add/remove backgrounds, and running tools pulse instead of showing spinner icons.
- **Inline retry indicator** — connection retry status moved from a banner above the editor into the chat thread with attempt count, delay, and an abort button.
- **Simplified chat sidebar** — removed background-session open/close controls from chat rows for a cleaner list.
- **Popover focus fix** — popovers inside canvas nodes (thinking level, model picker, stats) now lazily resolve their portal target instead of caching a stale DOM ref, fixing cases where popovers opened but couldn't receive clicks.

### Fixed

- **Auto-update download retry** — failed downloads now retry automatically and skip the dialog for patch updates.
- **README** — updated feature descriptions to cover agent panel, document panels, and current feature set; resolved leftover merge conflict markers.

## [1.0.1] - 2026-05-25

Patch release with new panel types, cross-platform fixes, and UI polish.

### Added

- **Document rendering panel** — new panel type for viewing PDF files (via pdf.js), DOCX files (via mammoth), and images natively on the canvas. File type is detected from magic bytes rather than relying solely on extensions.
- **Markdown preview in editor** — markdown files now show a Preview/Source toggle (top-right corner) that switches between Monaco editing and a rendered view using react-markdown with GFM support. The editor stays mounted while hidden so switching back is instant.
- **Themed titlebar drag strip on macOS** — when native tabs are off (now the default), a themed 28 px strip renders above the canvas with traffic-light alignment, collapsing automatically in native fullscreen.
- **Post-update dialog redesign** — shown on first launch (not just updates) with Product Hunt embed, GitHub star count, and newsletter links.

### Fixed

- **Ctrl+V paste in terminal panels on Windows/Linux** — xterm.js was encoding a literal `^V` (0x16) to the PTY instead of pasting. The custom key handler now yields to the browser's native paste event for the Ctrl+V chord on non-macOS.
- **Windows agent launch crash (spawn node ENOENT)** — pi's shell-less `spawn("node", ...)` couldn't find a `.cmd` wrapper on Windows. The shim now creates a real `node.exe` hardlink to the Electron binary.
- **Windows node shim without Developer Mode** — replaced symlink-based shim with a lightweight `node.cmd` batch wrapper that doesn't require admin/Developer Mode privileges.
- **OAuth flows blocked in webview** — Google and other providers block embedded webview sign-in. OAuth navigations now open in the system browser via `shell.openExternal`.
- **Closing a canvas node leaked its panels** — child terminals/editors/browsers stayed registered and running after the parent node was closed. `handleClose` now calls `closePanel` for every child before removing the node.
- **macOS microphone entitlement** — added `com.apple.security.device.audio-input` entitlement and `NSMicrophoneUsageDescription` so child processes (e.g. Claude Code voice input) can access CoreAudio.
- **Creating files/folders in an empty explorer folder** — the inline name-entry input was gated behind a non-empty tree; now renders when `rootCreating` is active.
- **CI build OOM** — set `NODE_OPTIONS --max-old-space-size` in the release workflow to prevent electron-vite bundling from running out of memory.

## [1.0.0] - 2026-05-24

First major release. Stabilises the agent panel, introduces semantic color tokens, and polishes the auto-updater.

### Changed

- **Semantic agent color tokens** — replaced hardcoded violet Tailwind classes with `agent` and `agent-light` color tokens defined in one place.
- **Agent panel polish** — automatic retry for marketplace fetch (cold connections often timeout on first attempt), increased timeout from 5 s to 8 s, and replaced native `<select>` for default model with the searchable picker used in the chat header.

### Fixed

- **Auto-update download fallback** — when electron-updater's initial check errors (e.g. provider mismatch), the fallback now broadcasts `available` instead of `manual`, so clicking Update attempts a native download first and only falls back to the release page if that fails.

## [0.4.12] - 2026-05-24

### Added

- **Unified command palette (Cmd+K)** — merged the panel switcher (Cmd+E) into a single Cmd+K overlay that shows open panels, project files, and commands in the default view. Cmd+E removed.

### Fixed

- **Pi binary resolution in marketplace** — resolve directly to `cli.js` instead of `.bin` symlink which doesn't survive asar unpacking.

## [0.4.11] - 2026-05-23

### Fixed

- **Agent child process module resolution** — use Electron's binary with `ELECTRON_RUN_AS_NODE=1` to spawn the pi agent child process, leveraging Electron's built-in asar support so transitive deps (like undici) resolve from inside the archive without unpacking.

## [0.4.10] - 2026-05-23

### Fixed

- **Agent asar (attempt 3)** — disable asar entirely to fix child process module resolution failures in production builds.

## [0.4.9] - 2026-05-23

### Fixed

- **Agent asar (attempt 2)** — unpack all `node_modules` from asar for child process spawning.

## [0.4.8] - 2026-05-23

### Fixed

- **Agent asar (attempt 1)** — unpack `pi-coding-agent` from asar for production builds.

## [0.4.7] - 2026-05-23

Version bump only — no functional changes beyond agent panel fixes already shipped in the v0.4.6 cycle.

## [0.4.6] - 2026-05-23

Major feature release: in-app AI agent, git worktrees, canvas detach, and analytics.

### Added

- **Pi agent panel** — in-app AI agent powered by `@earendil-works/pi-agent-core` with OAuth auth flow (Claude, ChatGPT, Copilot), provider management, marketplace for extensions, chat thread UI, plan-mode install flow, per-chat model restore on resume, and a collapsible model picker grouped by provider.
- **First-class git worktrees** — new "Parallel Work" sidebar tab promoting git worktrees from a hidden primitive to a user-friendly concept. Per-worktree color identity, status badges (dirty/ahead/behind), actions to open terminal/agent, merge back, or delete. Canvas nodes show a worktree color pill in the title bar; terminal/agent icons tinted by worktree in sidebar and tabs.
- **Update analytics** — track update button clicks and feedback dismissals.

### Changed

- **Minimap redesign** — animated pill that expands in-place instead of the popover+button pattern. The `showMinimap` setting removed; the button is always visible.
- **Panel-type registry** — centralised per-type metadata so adding a new panel type is a two-touch change instead of editing a dozen switch statements. Net −239 LOC.
- **Workspace multi-select** — shift-click multi-select in the workspace list with bulk-delete via context menu.

### Fixed

- **Canvas detach preserves children** — detaching a canvas panel to its own window now transfers child panel states and canvas state (nodes, regions, viewport, zoom), so children render correctly instead of as generic stubs.
- **Canvas-on-canvas blocked** — dropping a canvas onto another canvas is now refused at three layers (data, commit, and receive) to prevent broken nested interaction.
- **Detached windows apply theme + settings** — `DockWindowShell` and `PanelWindowShell` now hydrate settings and subscribe to appearance mode changes.
- **Agent OAuth flows** — `shell.openExternal` fires on auth/device-code events; auth URL stays visible above the paste-code form instead of being clobbered.
- **Browser panel stability** — stabilise webview `src` to prevent re-navigation on re-render; ignore `about:blank` transient navigations; drop teardown `loadURL` that was clobbering session-restore URLs.
- **Dock tab bar padding in detached canvas nodes** — nested mini-dock tab bars no longer inherit the 78 px traffic-light reservation.

## [0.4.5] - 2026-05-21

Refactoring release: unified drag system, simplified surface area, and codebase cleanup.

### Changed

- **Unified drag/drop runtime** — new `src/renderer/drag/` module replacing `useNodeDrag`, `useDockDrag`, `CanvasDropZone`, `DragGhost`, `DropZoneOverlay`, and `dropExecution`. Cross-window aware with full unit and scenario test coverage. `DockTabStack` split from 889 lines into focused units (`DockTabBar`, `DockTabContextMenu`, `useDockTabActions`, `useDockTabDrag`).
- **OS-only notifications** — replaced in-app notification/toast system with native OS notifications; sidebar status simplified to running pulse + awaiting-input ring.
- **Terminal URL handling** — replaced auto-opening terminal URLs with a per-terminal inline prompt; setting becomes `off` | `auto` | `prompt` (default `prompt`).
- **Canvas grid** — removed grid snapping and line-grid style; grid is now a fixed-spacing decorative dot pattern.

### Removed

- **Canvas annotations and freehand drawings** — removed the annotation, drawing, and connection-wire feature set along with image-add IPC.
- **Sidebar file explorer** — removed the explorer sidebar toggle.
- **Bundled MCP registry** and `aiAssistEnabled` setting.
- **Unused IPC/preload surface** — `http:fetch`, `shell:which`, `session:clear`, `app:getPath`, `dialog:saveFile`, crash report save, and others.
- **Website and docs directories** — removed the separate marketing site and out-of-date design specs.
- **Dead code** — `bun.lock`, `animation.ts`, custom `ContextMenu.tsx`, `.claude/` artifacts.

## [0.4.4] - 2026-05-19

### Changed

- **Canvas drop zone overhaul** — accepts drops anywhere on the canvas (no pill gate); reserves a 60 px outer strip for dock indicators. Ghost preview matches the dropped node's real size. Source node hidden during drag.
- **Spring-load** — maximised canvas nodes un-maximise 200 ms into a drag so the canvas underneath becomes a drop target. Canvas tabs spring-activate at 250 ms.
- **Tab title resolution** — falls back to a fresh `appStore` read and panel-type label, so tabs no longer render as generic "Panel". Mini-dock layouts sweep orphan panel IDs.

### Fixed

- **Update & restart** — `quitAndInstall(false, true)` and `will-quit` handler now skip `reallyExit(0)` while an update install is in flight, so Electron's relaunch hook actually fires.

## [0.4.3] - 2026-05-19

### Fixed

- **Terminal create failure retry** — a failed `terminal:create` no longer becomes a permanent tombstone. The half-built registry entry is torn down and a "Failed to start terminal" overlay with a Retry button is shown. Retry re-runs `getOrCreate` from scratch without requiring an app restart.
- **Explorer tracked-file dimming** — `gitLsFiles` returns repo-relative paths but the tree used absolute paths, so the tracked-files set never matched. Now prefixed with the repo root.
- **Windows shell resolution** — enhanced fallback logic for finding a usable shell on Windows.

## [0.4.2] - 2026-05-19

### Changed

- **Inline update progress** — the update pill is now the sole affordance (no popover). Click while available starts the download; progress fills inside the pill; on completion, auto-triggers `quitAndInstall` so the app restarts to install.

## [0.4.1] - 2026-05-18

### Fixed

- **Toolbar and welcome page centering** — now inset by sidebar widths so they center within the visible canvas area as sidebars open/close.
- **Minimap popover palette** — uses canonical brand palette instead of muted floating-mode tones.
- **Recent-folder open race** — welcome page awaits `setWorkspaceRootPath` before `createTerminal`, so the terminal reliably gets the right cwd.
- **Welcome page reappearing** — gated on `workspace.rootPath` being empty, so an initialised workspace shows a blank canvas instead of the start page.
- **Per-workspace canvas focus** — sidebar now resolves the workspace's own canvas store when computing children and jumping to panels.

## [0.4.0] - 2026-05-18

First release after the v0.3 series. Focus: error reporting, auto-updater, canvas drawing, and codebase simplification.

### Added

- **Sentry crash reporting** — replaced the homegrown crash reporter with Sentry (`@sentry/electron`). DSN via env var; gated by a `crashReportingEnabled` setting (default on).
- **Auto-updater UI** — in-app update pill in the canvas toolbar. Main-process auto-updater broadcasts status (idle/checking/available/downloading/downloaded/manual/error); renderer subscribes and renders the pill.
- **Freehand pencil drawings** — pencil tool for drawing strokes directly on the infinite canvas. Strokes live in canvas-space, pan/zoom with the workspace, and support click-to-select, drag, color palette, and delete.
- **Terminal URL auto-open** — scans PTY output for URLs and routes them to an existing browser panel (or creates one). Gated by `autoOpenUrlsFromTerminal` setting (default off). Includes a portal registry for driving existing webviews.

### Changed

- **Removed AI config and MCP subsystem** — stripped AI configuration UI, MCP server management, and all related IPC/types/preload bindings.
- **Removed usage tracking** — deleted usage-tracking popover, IPC channels, types, and related sidebar UI.

### Internal

- Coordinate system unit tests (`canvasToView` / `viewToCanvas` / `viewFrame`).

## [0.3.3] - 2026-05-13

Patch release with one canvas-placement papercut.

### Fixed

- **New panels always opened to the right of the focused one**, even when an empty slot sat directly above, below, or to the left. `findFreePosition` in `canvasStore` now rays out in all four cardinal directions from the reference node, jumps past obstructing nodes along each ray, and returns the slot whose center is closest to the reference — so opening a terminal next to a focused panel uses whichever side actually has open space.

## [0.3.2] - 2026-05-13

Patch release with a single terminal-startup fix.

### Fixed

- **"Failed to create terminal: path is outside allowed directories"** — `setWorkspaceRootPath` applied the new `rootPath` optimistically in the renderer but the main-process `workspace:update` that registers the path with `allowedRoots` is async; a `terminal:create` firing in that window failed `validateCwd` in main and surfaced as a red error in the terminal panel (with a restart as the only workaround, because `SESSION_LOAD` preemptively re-adds persisted roots). `terminalRegistry.getOrCreate` now awaits a new `awaitWorkspaceSync()` helper exported from `appStore` before sending `terminal:create`, so any pending workspace create/update lands first.

## [0.3.1] - 2026-05-13

Patch release with two papercut fixes from the v0.3.0 cycle and a file-explorer feature.

### Added

- **File explorer copy/paste** — Copy / Paste entries on the file, folder, and root-background context menus, backed by a new `FS_COPY` IPC that uses `fs.cp` recursively with collision-safe renaming (`copy`, `copy 2`, …). Multi-select copy supported. Paste is disabled when the clipboard is empty.

### Fixed

- **Folder double-click no longer opens every direct child as a tab** — folders now ignore double-click; single-click still toggles expansion.
- **New terminal opens in the picked folder, not `$HOME`** — `setWorkspaceRootPath` only flipped `isRootPathPending` locally and waited for the main-process IPC roundtrip before exposing `rootPath`, so `WelcomePage` spawning a terminal right after picking a folder mounted the panel before the path was readable and the PTY fell back to `os.homedir()`. Now applies `rootPath` (and the derived name) optimistically before the IPC roundtrip.
- **"Cate crashed unexpectedly" dialog after a clean shutdown** — React 18's `logCaughtError` wraps thrown DOM `Event`s as `"Uncaught [object Event]"`, but the existing renderer filter only matched the bare `"[object Event]"` form, so a single non-Error throw during teardown persisted a crash report and resurfaced the dialog on next launch. Extracted `isNonInformativeMessage()` (also matches `"Uncaught [object Object]"` and the generic `^Uncaught \[object …\]$` shape) and applied it on both the `window` error path and the `ErrorBoundary`.

### Internal

- **Renderer source maps in production builds** — crash-report stacks now point at real source locations instead of opaque bundle offsets, which we need to track down whoever is throwing the raw `Event` in the first place.

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
