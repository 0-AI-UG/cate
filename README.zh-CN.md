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

> **注意：** 本翻译由机器自动生成，可能存在不准确之处。

<p align="center">
  一块无限画布，容纳你的代码、终端、浏览器、文档和 AI 智能体。
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

Cate 是一款基于无限画布的桌面 IDE。不再堆叠窗口和标签页，而是把编辑器、终端、浏览器、文档和 AI 智能体铺展在自由空间里，按你对项目的思路来摆放。面板可以浮在画布上、停靠成标签和分屏，或拆分到各自的系统窗口。重新打开文件夹时，Cate 会还原一切。

## 快速开始

打开一个文件夹。Cate 会把它变成一个工作区，每次回来都会还原你的布局、面板位置和终端。右键点击画布添加面板，按 `Cmd+K` 打开命令面板，把面板拖到停靠区即可创建标签和分屏。无需任何配置文件。

## 为什么用画布？

在你只有几个窗口时，Alt-Tab 够用了。可一旦开着十几个终端、六个文件、文档在另一个窗口、笔记又散落在好几个桌面上，找到正确的窗口本身就成了瓶颈。

Cate 给每个项目一块画布，记住你把东西放在哪里。它不是窗口管理器。Hyprland、Niri、GlazeWM 这类平铺式 WM 负责排布你运行的所有系统窗口；Cate 排布的是单个项目的工具，更接近 Figma 而非 WM。

## 包含什么

**画布与布局。** 缩放、平移无限画布，把面板停靠成四个区域的标签和分屏，把面板拆分到独立窗口，并保存命名布局。同时开着多个项目，重启后逐一还原。

**编辑器与终端。** Monaco 编辑器面板，支持语法高亮、多光标、查找/替换、差异对比和 Markdown 预览。基于 `node-pty` 的原生 xterm.js 终端，植根于工作区并自动检测 shell。文档面板可渲染 PDF、DOCX 和图片。

**Git。** 一棵感知 git 的文件树，带实时监听与搜索；外加版本控制侧边栏，处理暂存、分支、worktree、历史和行内差异。项目级全文搜索。

**AI 智能体。** 运行内置的编码智能体（Pi），支持聊天线程和按线程记忆模型。通过 OAuth 或 API key 接入 Anthropic、OpenAI Codex、GitHub Copilot、Gemini、OpenRouter、Groq、Mistral、DeepSeek 等。可从市场安装扩展。

**导航。** 跨画布搜索文件、终端回滚和面板标题（`Cmd+Shift+F`）。面板切换器（`Ctrl+Space`）。命令面板（`Cmd+K`）。

## 安装

下载预构建版本。日常使用请勿从源码构建。

| 平台 | 格式 | 链接 |
|----------|---------|------|
| macOS | DMG、ZIP（`arm64`、`x64`） | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS 安装器、ZIP（`x64`） | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage、DEB、`tar.gz`（`x64`） | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS：** 发布版本已公证。未签名的本地构建可能需要 `xattr -cr /Applications/Cate.app`。

> **Linux：** 在 Steam Deck 或根目录只读的发行版上，请用 `tar.gz` 版本。若 AppImage 无法启动，试试 `./Cate.AppImage --no-sandbox`。

## 从源码构建

面向贡献者。其他情况请用上面的发布版本。

**前置条件：**
- [Node.js](https://nodejs.org/) 20 或 22 LTS（见 `.nvmrc`）。Node 23+ 会失败：`node-pty` 没有预构建产物，原生编译会出错。
- npm >= 9
- 用于 `node-pty` 的 Python 3 和 C++ 编译器：
  - macOS：`xcode-select --install`
  - Debian/Ubuntu：`sudo apt install build-essential python3`
  - Fedora/RHEL：`sudo dnf install @development-tools gcc-c++ make python3`
  - Arch：`sudo pacman -S base-devel python`
  - Windows：[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 "Desktop development with C++" 工作负载

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install

npm run dev          # 带热重载的开发服务器
npm run typecheck
npm test             # 单元测试（vitest）
npm run test:e2e     # Playwright 集成测试
npm run build        # 生产构建
npm run package      # 打包分发（:mac、:win、:linux）
```

打包后的二进制文件位于 `release/`。

## 架构

```text
src/
├── agent/      # 内置 Pi 编码智能体：进程管理、鉴权、市场、面板 UI
├── main/       # Electron 主进程：IPC、工作区、窗口、更新器、安全
├── preload/    # 上下文隔离的 IPC 桥
├── renderer/   # React 18 应用：画布、停靠、面板、侧边栏、store、hooks
└── shared/     # IPC 通道与共享类型
```

Cate 的所有 IPC 都经过上下文隔离的 preload 桥。文件系统访问限定在已注册的工作区根目录，浏览器面板禁用 Node 集成，终端无法在批准目录之外启动。

**技术栈：** Electron 41、React 18、Zustand 5、Monaco 0.52、xterm.js 5.5 + node-pty 1.0、Tailwind 3.4、electron-vite、electron-builder、electron-updater、Sentry。PDF 和 DOCX 用 pdf.js 与 mammoth，git 用 simple-git，文件监听用 chokidar。智能体运行时为 `@earendil-works/pi`。

## 贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。逐版本的历史记录在 [CHANGELOG](CHANGELOG.md)。

## Star 历史

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## 许可证

[MIT](LICENSE)
