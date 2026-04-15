<p align="center">
  <img src="build/icon.png" alt="Cate" width="160" />
</p>

<h1 align="center">Cate</h1>

<p align="center">
  A spatial desktop IDE with an infinite canvas for code, terminals, browsers, and git.
</p>

<p align="center">
  <strong>Current source version:</strong> v0.2.17
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT License" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Cate demo" width="900" />
</p>

Cate is an Electron desktop app for arranging development tools in freeform space. You can mix floating canvas panels with docked tabs and splits, detach panels into separate windows, and keep multiple workspaces synced across sessions.

## Features

- **Infinite canvas + docking** — arrange panels spatially, or dock them into tabs and splits
- **Multi-workspace sessions** — keep several projects open and restore them on restart
- **Detached windows** — pull panels or full dock layouts into separate windows
- **Code editing** — Monaco-powered editor panels with diff support
- **Native terminals** — xterm.js + `node-pty`, rooted in the active workspace
- **Browser panels** — embedded web previews with hardened webview settings
- **Explorer + search** — git-aware file tree, live filesystem watching, and project search
- **Source control** — stage/unstage, branch management, worktrees, commit history, and diff views
- **Agent setup** — bootstrap Claude Code, OpenAI Codex, Gemini, Cursor, and OpenCode configs, plus manage MCP servers
- **Layouts and commands** — command palette, saved layouts, workspace export/import, global search, and keyboard shortcuts
- **Desktop polish** — auto-save/session restore, optional native macOS window tabs, and update checks

## Download

This repository currently targets **v0.2.17**.

| Platform | Formats | Link |
|----------|---------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS installer, ZIP (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [Latest release](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS note:** release builds are configured for hardened runtime and notarization. Unsigned local or test builds may still require:
> ```bash
> xattr -cr /Applications/Cate.app
> ```

## Build from Source

### Prerequisites

- [Node.js](https://nodejs.org/) 20 or 22 LTS (see `.nvmrc`). Node 23+ is not supported; `node-pty` has no prebuilds and native compilation will fail.
- npm >= 9
- Python 3 and a C++ compiler (for `node-pty` native module)
  - macOS: Xcode Command Line Tools (`xcode-select --install`)
  - Debian/Ubuntu: `sudo apt install build-essential python3`
  - Fedora/RHEL: `sudo dnf install @development-tools gcc-c++ make python3`
  - Arch: `sudo pacman -S base-devel python`
  - Windows: [windows-build-tools](https://github.com/nicedoc/windows-build-tools)

### Setup

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install
```

### Development

```bash
npm run dev
```

This starts the Electron app with hot reload via electron-vite.

### Quality Checks

```bash
npm run typecheck
npm test
```

For the Electron smoke test harness:

```bash
npm run test:smoke:electron
```

### Production Build

```bash
npm run build
```

### Package for Distribution

```bash
npm run package
# or target one platform:
npm run package:mac
npm run package:win
npm run package:linux
```

Packaged binaries will be in the `release/` directory.

## Security & Packaging

Cate uses a context-isolated preload bridge, workspace-scoped filesystem access, hardened browser panels, and a safer update fallback that opens the GitHub release page when a verified installer path is unavailable. See [docs/packaging-security.md](docs/packaging-security.md) for the current macOS entitlement notes.

## Architecture

```text
src/
├── main/           # Electron main process — IPC, security, updater, workspace lifecycle
├── preload/        # Context-isolated bridge exposed to the renderer
├── renderer/       # React app
│   ├── canvas/     # Infinite canvas rendering and state
│   ├── docking/    # Tabs, splits, detached dock windows, drag/drop
│   ├── panels/     # Editor, terminal, browser, git, explorer, project panels
│   ├── sidebar/    # Workspaces, explorer, source control, agent setup, usage
│   ├── settings/   # App settings UI
│   ├── shells/     # Main, panel, and dock window shells
│   └── stores/     # Zustand state management
└── shared/         # IPC channel definitions and shared types
```

- **Electron 41** for the desktop shell
- **React 18** for the UI
- **Zustand** for state management
- **Monaco Editor** for code editing
- **xterm.js + node-pty** for terminals
- **simple-git** for source control operations
- **electron-updater** for release checks
- **Tailwind CSS** for styling
- **electron-vite** for bundling

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
