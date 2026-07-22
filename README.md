<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cate-logo.svg" />
    <img src="assets/cate-logo-light.svg" alt="Cate" width="140" />
  </picture>
</p>

<p align="center">
  <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  An infinite canvas IDE for parallel coding agents.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Downloads" /></a>
</p>

---

<p align="center">
  <img src="assets/demo-canvas.gif" alt="Cate demo" width="900" />
</p>

Cate is a desktop IDE built on an infinite canvas, made for running many terminals and coding agents at once. Run Claude Code, Codex, or any agent CLI in a Cate terminal and the canvas becomes mission control: every terminal shows whether its agent is working, finished, or waiting on you, and Cate sends a notification the moment one needs input. Spin up parallel git worktrees with one click and each gets its own colored territory on the canvas, so five agents on five branches stay five visibly separate workstreams instead of a pile of tabs.

Around that core is a full IDE: Monaco editors, embedded browsers, document viewers, git tooling, and an in-app agent chat. Float panels anywhere on the canvas, dock them into tabs and splits, or detach them into their own OS windows. Cate restores the whole layout when you reopen the folder.

**Getting started:** open a folder and it becomes a workspace. Right-click to add panels, press `Cmd+K` for the command palette, drag panels onto the dock to build tabs and splits. No config files.

## Install

Download a prebuilt release. Don't build from source for daily use.

| Platform | Formats | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS installer, ZIP (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |

On macOS you can also install with Homebrew:

```sh
brew install --cask cate
```

## What's inside

- **Agent-aware terminals.** Cate hooks the agent CLIs it supports (Claude Code, Codex, Cursor, Grok, OpenCode, Pi), so the agent itself reports turn start, turn end, and permission prompts. That drives the panel's running / waiting / finished state and the notification you get when one needs an answer. An agent that posts no hooks shows no status.
- **Agent sessions survive restarts.** The hook stream carries each CLI's session id. Reopen the project and terminals return with their scrollback, and the agent is reattached with its own resume command. A stale id falls back to a plain shell rather than resuming the wrong conversation.
- **Worktrees for parallel branches.** Type what you're working on and Cate creates a worktree and branch, based on a local or remote branch or an open PR. Each gets a color that follows it through the sidebar, dock tabs, and a territory drawn behind its panels on the canvas.
- **Panels on a canvas or in a dock.** Terminals, Monaco editors, browsers, PDF/image/DOCX viewers, extension webviews, nested canvases. Float them on the canvas, dock them into tabs and splits, or drag them into their own window. Layout persists per project.
- **Git and search.** Source-control sidebar for staging, commits, branches, stash, and history across multiple repos; git badges in the file tree; side-by-side diffs. Ripgrep search over the workspace, and `Cmd+K` for commands, panels, and files.
- **A CLI agents can call.** In a Cate terminal, `cate` drives a browser panel (`open`, `screenshot`, `snapshot`, `click`, `type`), reads another terminal, opens files, manages panels. Settings → CLI gates each surface separately for Read and Control.
- **Local and remote are the same path.** One runtime daemon serves every workspace. Point Cate at a host over SSH or WSL and terminals, git, search, and agents run there; editors, browser, and canvas stay local.

## Extensions

Cate has an extension system for third-party panels (MCP servers, diagrams, and more), each served in its own isolated webview. Browse and build them in the companion repo: [0-AI-UG/cate-extensions](https://github.com/0-AI-UG/cate-extensions).

## Keyboard shortcuts

macOS shown below; on Windows/Linux use `Ctrl` in place of `Cmd`.

| Panels & files | | View & navigation | |
|---|---|---|---|
| New terminal | `Cmd+T` | Command palette | `Cmd+K` |
| New editor | `Cmd+Shift+E` | Search everything | `Cmd+Shift+F` |
| New browser | `Cmd+Shift+B` | Toggle sidebar | `Cmd+B` |
| New agent | `Cmd+Shift+A` | Toggle file explorer | `Cmd+Shift+X` |
| New canvas | `Cmd+Shift+C` | Toggle minimap | `Cmd+Shift+M` |
| New file | `Cmd+N` | Focus next / previous panel | `Ctrl+Tab` / `Ctrl+Shift+Tab` |
| Save file | `Cmd+S` | Move between panels | `Cmd+←↑↓→` |
| Close panel | `Cmd+W` | Delete focused panel | `Cmd+Backspace` |

| Canvas | |
|---|---|
| Zoom in / out | `Cmd+=` / `Cmd+-` |
| Reset zoom | `Cmd+0` |
| Zoom to fit / selection | `Cmd+1` / `Cmd+2` |
| Auto-layout canvas | `Cmd+Shift+L` |
| Pan canvas | `Shift+←↑↓→` |
| Toggle select / hand tool | `Shift+Space` |
| Undo / redo | `Cmd+Z` / `Cmd+Shift+Z` |

Every shortcut is rebindable in Settings.

## Build from source

For contributors. Use the release above otherwise.

**Prerequisites:**
- [Bun](https://bun.sh): package manager and script runner.
- [Node.js](https://nodejs.org/) 20 or 22 LTS (see `.nvmrc`) on your PATH. The build scripts run under it; the runtime daemon bundles its own Node 22.
- **Linux only:** `node-pty` ships prebuilt binaries for macOS and Windows, but not Linux, so it compiles from source there. Install Python 3 and a C++ toolchain:
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`

Fresh clone, one command sets everything up (installs dependencies and builds the local runtime daemon):

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
bun run setup
```

Then:

```bash
bun run dev          # dev server with hot reload
bun run typecheck
bun run test         # unit tests (vitest)
bun run test:e2e     # Playwright integration tests
bun run build        # production build
bun run package      # package for distribution (:mac, :win, :linux)
```

Packaged binaries land in `release/`. The runtime daemon is rebuilt by `bun run runtime:tarball` (re-run it after changing anything under `src/runtime/`).

## Architecture

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

Cate runs all IPC through a context-isolated preload bridge. Filesystem access is scoped to registered workspace roots, browser panels disable node integration, and terminals can't spawn outside approved directories.

**Stack:** Electron 41, React 18, Zustand 5, Monaco 0.52, xterm.js 5.5 + node-pty 1.0, Tailwind 3.4, electron-vite, electron-builder, electron-updater, Sentry. PDFs and DOCX via pdf.js and mammoth, git via simple-git, file watching via `@parcel/watcher` and chokidar. The embedded coding agent is built on `@earendil-works/pi`, shipped as an on-demand runtime alongside the app.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Release-by-release history lives in the [CHANGELOG](CHANGELOG.md).

## Star history

<a href="https://www.star-history.com/?repos=0-AI-UG%2Fcate&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&theme=dark&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=0-AI-UG/cate&type=date&legend=top-left&sealed_token=LE-sv5TdJtUmugufglkRue9ZJ6mVXcScJNurvXl9qwGAOHy-taiZA7-UfpBCAHbsxUZESm-1aSxX55u3DTth--kCTUty5gqe7XMhmI-dHz2IOkizZgAk26fW8iovuRbeMSyla3c2T9w9fAj6x2_SZZEGbmvonWJvvLcI-X35nHZFkQQIn_ueBO07uQZM" />
 </picture>
</a>

## License

[MIT](LICENSE)
