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
  An infinite canvas for your code, terminals, browsers, docs, and AI agents.
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

Cate is a desktop IDE built on an infinite canvas. Spread editors, terminals, browsers, docs, and AI agents across freeform space instead of stacking windows and tabs. Float them, dock them into tabs and splits, or detach them into their own OS windows, and Cate restores the whole layout when you reopen the folder.

**Getting started:** open a folder and it becomes a workspace. Right-click to add panels, press `Cmd+K` for the command palette, drag panels onto the dock to build tabs and splits. No config files.

## Install

Download a prebuilt release. Don't build from source for daily use.

| Platform | Formats | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS installer, ZIP (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS:** release builds are notarized. Unsigned local builds may need `xattr -cr /Applications/Cate.app`.

> **Linux:** on Steam Deck or read-only-root distros, use the `tar.gz` build. If the AppImage won't launch, try `./Cate.AppImage --no-sandbox`.

## What's inside

- **Canvas & layout:** infinite zoom and pan, docking into tabs and splits across four zones, detachable windows, saved layouts, and multi-project session restore.
- **Editors & terminals:** Monaco editors with syntax highlighting, multi-cursor, diffs, and Markdown preview; native xterm.js terminals via `node-pty`; document panels for PDFs, DOCX, and images.
- **Git:** git-aware file tree with live watching, plus a source-control sidebar for staging, branches, worktrees, history, and inline diffs. Full-text search.
- **AI agents:** in-app coding agent (Pi) with chat threads and per-chat model memory. Connect Anthropic, OpenAI Codex, GitHub Copilot, Gemini, OpenRouter, Groq, Mistral, DeepSeek, and more via OAuth or API key.
- **Navigation:** canvas-wide search across files, terminal scrollback, and panel titles; command palette; panel-to-panel keyboard navigation.

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
- [Node.js](https://nodejs.org/) 20 or 22 LTS (see `.nvmrc`) on your PATH. The build scripts run under it; the companion daemon bundles its own Node 22.
- **Linux only:** `node-pty` ships prebuilt binaries for macOS and Windows, but not Linux, so it compiles from source there. Install Python 3 and a C++ toolchain:
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`

Fresh clone, one command sets everything up (installs dependencies and builds the local companion daemon):

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

Packaged binaries land in `release/`. The companion daemon is rebuilt by `bun run companion:tarball` (re-run it after changing anything under `src/companion/`).

## Architecture

```text
src/
├── agent/      # Embedded Pi coding-agent: process manager, auth, marketplace, panel UI
├── main/       # Electron main process: IPC, workspaces, windows, updater, security
├── preload/    # Context-isolated IPC bridge
├── renderer/   # React 18 app: canvas, docking, panels, sidebar, stores, hooks
└── shared/     # IPC channels and shared types
```

Cate runs all IPC through a context-isolated preload bridge. Filesystem access is scoped to registered workspace roots, browser panels disable node integration, and terminals can't spawn outside approved directories.

**Stack:** Electron 41, React 18, Zustand 5, Monaco 0.52, xterm.js 5.5 + node-pty 1.0, Tailwind 3.4, electron-vite, electron-builder, electron-updater, Sentry. PDFs and DOCX via pdf.js and mammoth, git via simple-git, file watching via chokidar. The agent runtime is `@earendil-works/pi`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Release-by-release history lives in the [CHANGELOG](CHANGELOG.md).

## Star history

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## License

[MIT](LICENSE)
