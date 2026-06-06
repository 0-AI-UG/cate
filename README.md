<p align="center">
  <a href="https://www.producthunt.com/products/cate?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-cate" target="_blank" rel="noopener noreferrer"><img alt="CATE - Figma like open canvas for development | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1150094&theme=neutral&t=1779630669260"></a>
</p>

<p align="center">
  <img src="assets/cate-logo.svg" alt="Cate" width="240" />
</p>

<h1 align="center">Cate</h1>

<p align="center">
  <a href="README.md">English</a> | <a href="README.fr.md">Français</a> | <a href="README.zh-CN.md">简体中文</a> | <a href="README.de.md">Deutsch</a>
</p>

<p align="center">
  An infinite canvas for your code, terminals, browsers, docs, and AI agents.
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="Downloads" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Cate demo" width="900" />
</p>

Cate is a desktop IDE built on an infinite canvas. Instead of stacking windows and tabs, you spread editors, terminals, browsers, documents, and AI agents across freeform space and arrange them however you think about the project. Float panels on the canvas, dock them into tabs and splits, or detach them into their own OS windows. Cate restores everything when you reopen the folder.

## Getting started

Open a folder. Cate makes it a workspace and brings back your layout, panel positions, and terminals each time you return. Right-click the canvas to add panels, press `Cmd+K` for the command palette, and drag panels onto the dock to build tabs and splits. There are no config files to set up.

## Why a canvas?

Alt-tab is fine until you have a dozen terminals, six open files, docs in another window, and notes spread across desktops. Past that point, finding the right window is the bottleneck.

Cate gives each project one canvas that remembers where you left things. This is not a window manager. Tiling WMs like Hyprland, Niri, and GlazeWM arrange OS windows for everything you run; Cate arranges the tools for a single project, closer to Figma than to a WM.

## What's inside

**Canvas and layout.** Zoom and pan an infinite canvas, dock panels into tabs and splits across four zones, detach panels into separate windows, and save named layouts. Keep several projects open and restore them on restart.

**Editors and terminals.** Monaco editor panels with syntax highlighting, multi-cursor, find/replace, diffs, and Markdown preview. Native xterm.js terminals backed by `node-pty`, rooted in the workspace with shell auto-detection. Document panels render PDFs, DOCX, and images.

**Git.** A git-aware file tree with live watching and search, plus a source-control sidebar for staging, branches, worktrees, history, and inline diffs. Full-text project search.

**AI agents.** Run an in-app coding agent (Pi) with chat threads and per-chat model memory. Connect Anthropic, OpenAI Codex, GitHub Copilot, Gemini, OpenRouter, Groq, Mistral, DeepSeek, and others via OAuth or API key. Install extensions from the marketplace.

**Navigation.** Canvas-wide search across files, terminal scrollback, and panel titles (`Cmd+Shift+F`). Panel switcher (`Ctrl+Space`). Command palette (`Cmd+K`).

## Install

Download a prebuilt release. Don't build from source for daily use.

| Platform | Formats | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS installer, ZIP (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS:** release builds are notarized. Unsigned local builds may need `xattr -cr /Applications/Cate.app`.

> **Linux:** on Steam Deck or read-only-root distros, use the `tar.gz` build. If the AppImage won't launch, try `./Cate.AppImage --no-sandbox`.

## Build from source

For contributors. Use the release above otherwise.

**Prerequisites:**
- [Bun](https://bun.sh) — package manager and script runner.
- [Node.js](https://nodejs.org/) 20 or 22 LTS (see `.nvmrc`) on your PATH. The build scripts run under it; the companion daemon bundles its own Node 22.
- **Linux only:** `node-pty` ships prebuilt binaries for macOS and Windows, but not Linux, so it compiles from source there. Install Python 3 and a C++ toolchain:
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`

Fresh clone — one command sets everything up (installs dependencies and builds the local companion daemon):

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
