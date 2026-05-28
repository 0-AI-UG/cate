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
  一个拥有无限画布的空间桌面 IDE，集成代码编辑、终端、浏览器、文档、AI 代理和 Git。
</p>

<p align="center">
  <strong>当前源码版本：</strong> v1.0.3
</p>

<p align="center">
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/v/release/0-AI-UG/cate?style=flat-square" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0-AI-UG/cate?style=flat-square" alt="MIT 许可证" /></a>
  <a href="https://github.com/0-AI-UG/cate/actions"><img src="https://img.shields.io/github/actions/workflow/status/0-AI-UG/cate/ci.yml?style=flat-square" alt="CI" /></a>
  <a href="https://github.com/0-AI-UG/cate/releases"><img src="https://img.shields.io/github/downloads/0-AI-UG/cate/total?style=flat-square" alt="下载量" /></a>
</p>

---

<p align="center">
  <img src="assets/demo.gif" alt="Cate 演示" width="900" />
</p>

Cate 是一款 Electron 桌面应用程序，用于在自由空间中组织开发工具。将浮动的画布面板与固定的标签页和分栏混合使用，将面板分离到独立窗口中，并在多个会话之间保持多个工作区同步。

## 快速开始

打开任意文件夹即可创建工作区——Cate 会在您每次回来时恢复画布布局、面板位置和已打开的终端。右键点击画布添加面板，按 `Cmd+K` 打开命令面板，或将面板拖到 Dock 栏创建标签页和分栏。

无需配置文件，无需项目设置——只需将 Cate 指向一个目录即可开始工作。

## 为什么选择 Cate？

Alt-Tab 切换在窗口少时很好用——但当你有 12 个终端、6 个打开的文件、另一个窗口中的文档，以及散落在各个桌面上的笔记时，切换窗口本身就成了真正的瓶颈。

Cate 用**每个项目一个持久化画布**替代了那堆窗口。终端、编辑器、浏览器和笔记保持在你放置的位置，按照你的思维方式分组，第二天回来时它们仍然在那里。

> Cate **不是窗口管理器的替代品**。平铺/滚动式窗口管理器（Hyprland、Niri、GlazeWM、KDE）在你主要想要排列操作系统窗口时非常好用。Cate 是围绕单个项目工具的空间画布——更接近 Figma 的无限画布，而非窗口管理器。

## 功能特性

### 🎨 画布与布局

- **无限画布** ——缩放、平移，在自由空间中随意排列面板。双指拖动或右键拖动平移；`Cmd+滚轮` 或画布控件缩放。
- **Dock 系统** ——将浮动面板拖到 Dock 栏创建标签页和分栏。每个 Dock 区域（中央、左侧、右侧、底部）可容纳多个带有类型着色图标的标签页。
- **分离窗口** ——将面板或完整的 Dock 布局拉到独立的操作系统窗口中。
- **保存的布局** ——从应用内弹窗（`Cmd+K → "保存的布局…"`）命名、保存、加载和删除画布排列（节点和区域）。
- **多工作区会话** ——同时打开多个项目，重启后恢复。通过侧边栏在工作区之间切换。

### 💻 代码、文档与终端

- **Monaco 编辑器面板** ——完整的 VS Code 级编辑体验，支持语法高亮、多光标、查找/替换、差异对比以及 Markdown 预览/源码模式（GFM 渲染）。草稿编辑器在会话之间保留未保存的内容。
- **持久化编辑器缓冲区** ——基于文件的模型在面板之间复用，草稿编辑器内容随会话持久化。
- **文档面板** ——画布上的原生 PDF、DOCX 文件和图片查看器，支持基于魔数字节的文件类型检测。
- **原生终端** ——xterm.js 配合 WebGL 渲染，由 `node-pty` PTY 支持，根植于活动工作区。自动检测 Shell，当配置的 Shell 不可用时优雅降级。
- **浏览器面板** ——嵌入式 webview 面板，用于预览文档、开发服务器或任意 URL。上下文隔离，安全设置加固。

### 🔧 Git 与源码控制

- **Git 感知的文件浏览器** ——文件树支持实时文件系统监视、已跟踪/未跟踪文件暗显、搜索，以及文件和文件夹的复制/粘贴（带防冲突重命名）。
- **源码控制侧边栏** ——暂存/取消暂存、分支管理、工作树、提交历史和内联差异视图。Git 监视器自动轮询并展示变更。
- **项目级搜索** ——在工作区文件中进行全文搜索，结果即时呈现。

### 🤖 AI 代理

- **Pi Agent 面板** ——运行由 `@earendil-works/pi-agent-core` 驱动的应用内编码代理，支持聊天线程、按聊天恢复模型和工作区感知的面板放置。
- **提供商认证与模型** ——连接 OAuth 提供商如 Anthropic、OpenAI Codex 和 GitHub Copilot，或 API 密钥提供商如 OpenAI、Google Gemini、OpenRouter、Groq、Mistral、DeepSeek 等。
- **市场与规划模式** ——从市场安装 Pi 扩展，使用 Cate 内置的规划模式助手进行代理引导的实施规划。

### 🔍 搜索与导航

- **画布级搜索**（`Cmd+Shift+F`）——Spotlight 风格的覆盖层，可同时搜索工作区文件、实时终端滚动缓冲区和已打开面板的标题/路径。结果按最近聚焦排序，带有类型着色的图标。
- **面板切换器**（`Ctrl+Space`）——紧凑的键盘覆盖层，用于在打开的画布面板之间跳转并将选定节点居中。
- **命令面板**（`Cmd+K`）——快速访问命令、已打开面板和工作区文件。所有覆盖层统一采用 Spotlight 风格的外观。

### 🖥️ 桌面细节

- **自动保存与会话恢复** ——所有面板状态、位置和打开的文件自动持久化。
- **可选的 macOS 原生窗口标签页** ——在系统标签栏中分组 Cate 窗口。
- **自动更新检查** ——检查 GitHub 发布版本，有新版本可用时通知。
- **崩溃恢复能力** ——Sentry 诊断、会话恢复验证、PTY 中的 Shell 降级横幅以及受保护的更新/重启流程，帮助防止嘈杂或循环的崩溃状态。

## 安装

如果您只想使用 Cate，请下载预构建版本——不要从源码编译。本仓库当前目标版本为 **v1.0.3**。

| 平台 | 格式 | 链接 |
|------|------|------|
| macOS | DMG, ZIP (`arm64`, `x64`) | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |
| Windows | NSIS 安装程序, ZIP (`x64`) | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |
| Linux | AppImage, DEB, `tar.gz` (`x64`) | [最新版本](https://github.com/0-AI-UG/cate/releases/latest) |

> **macOS 注意：** 发布版本已公证并配置为强化运行时。未签名的本地或测试版本可能需要：
> ```bash
> xattr -cr /Applications/Cate.app
> ```

> **Linux 注意：** 在 Steam Deck 或其他只读根分区的发行版上，建议使用 `tar.gz` 便携版本。如果 AppImage 无法启动，请尝试 `--no-sandbox` 作为备选方案（例如 `./Cate.AppImage --no-sandbox`）。

## 从源码编译

> 以下步骤面向**贡献者**——日常使用请下载上述预构建版本。

### 前置要求

- [Node.js](https://nodejs.org/) 20 或 22 LTS（见 `.nvmrc`）。不支持 Node 23+；`node-pty` 没有预编译包，原生编译会失败。
- npm >= 9
- Python 3 和 C++ 编译器（用于 `node-pty` 原生模块）
  - macOS：Xcode 命令行工具（`xcode-select --install`）
  - Debian/Ubuntu：`sudo apt install build-essential python3`
  - Fedora/RHEL：`sudo dnf install @development-tools gcc-c++ make python3`
  - Arch：`sudo pacman -S base-devel python`
  - Windows：[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（选择"使用 C++ 的桌面开发"工作负载）

### 设置

```bash
git clone https://github.com/0-AI-UG/cate.git
cd cate
npm install
```

### 开发

```bash
npm run dev
```

这将通过 electron-vite 启动带有热重载的 Electron 应用。

### 质量检查

```bash
npm run typecheck
npm test            # 单元测试 (vitest)
npm run test:e2e    # Playwright 集成测试
```

Electron 冒烟测试工具：

```bash
npm run test:smoke:electron
```

### 生产构建

```bash
npm run build
```

### 打包分发

```bash
npm run package
# 或指定目标平台：
npm run package:mac
npm run package:win
npm run package:linux
```

打包后的二进制文件位于 `release/` 目录。

## 安全与打包

Cate 使用上下文隔离的预加载桥接进行所有 IPC 通信。文件系统访问范围限定在已注册的工作区根目录内，浏览器面板使用禁用 Node 集成的强化 webview 设置，更新器在验证的安装程序路径不可用时会回退到打开 GitHub 发布页面。工作区范围的 `allowedRoots` 验证防止终端在批准的目录之外启动。

## 架构

```text
src/
├── agent/              # 嵌入式 Pi 编码代理集成
│   ├── main/           # 代理进程管理器、认证、市场、会话文件
│   ├── renderer/       # 代理面板 UI、聊天线程、提供商、模型偏好
│   └── extensions/     # Cate 内置的规划模式 Pi 扩展
├── main/               # Electron 主进程
│   ├── ipc/            # IPC 处理器（文件系统、git、终端、菜单、拖拽）
│   ├── analytics       # 更新/应用事件分析助手
│   ├── appContext      # 共享主进程应用状态
│   ├── featureFlags    # 运行时功能标志
│   ├── shellEnv        # 登录 Shell 环境捕获
│   ├── shellResolver   # Shell 路径解析与降级链
│   ├── workspaceManager# 工作区生命周期和会话持久化
│   ├── workspaceRoots  # 允许的根目录注册和验证
│   ├── windowRegistry  # 窗口管理（主窗口、Dock、分离窗口）
│   ├── webSecurity     # Webview 加固和 CSP
│   ├── auto-updater    # 更新检查和发布获取
│   ├── sentry          # Sentry 集成
│   ├── store           # electron-store 持久化
│   ├── jsonFileStore   # JSON 文件持久化助手
│   ├── menu            # 应用菜单
│   └── sessionTrust    # 会话恢复验证
├── preload/            # 暴露给渲染器的上下文隔离桥接
├── renderer/           # React 18 应用
│   ├── assets/         # 渲染器图片和资源声明
│   ├── canvas/         # 无限画布渲染、拖拽、调整大小、放置
│   ├── docking/        # 标签页、分栏、分离的 Dock 窗口、拖放
│   ├── drag/           # 跨窗口拖放运行时和状态
│   ├── panels/         # 终端、编辑器、浏览器、文档、Git、浏览器、
│   │                   # 项目、画布面板注册/组件
│   ├── sidebar/        # 工作区、文件浏览器、源码控制、
│   │                   # 并行工作、项目列表、文件剪贴板
│   ├── dialogs/        # 保存的布局和更新后反馈对话框
│   ├── settings/       # 设置窗口部分和快捷键录制器
│   ├── ui/             # 命令面板、全局搜索、节点切换器、
│   │                   # 欢迎页面、快捷键提示覆盖层
│   ├── shells/         # 主窗口、面板和 Dock 窗口外壳
│   ├── stores/         # Zustand 状态仓库（画布、应用、Dock、设置、
│   │                   # 快捷键、状态、UI、更新、URL 提示）
│   ├── hooks/          # 自定义 React Hooks（快捷键、画布交互）
│   ├── lib/            # 工具函数（坐标、路由、终端注册表）
│   ├── workers/        # Monaco/编辑器 Workers
│   └── styles/         # Tailwind/全局样式
└── shared/             # IPC 通道定义和共享 TypeScript 类型
```

### 技术栈

- **Electron 41** ——桌面外壳（Chromium + Node.js）
- **React 18** ——UI 框架，函数组件和 Hooks
- **Zustand 5** ——轻量级状态管理（无 Redux/Context）
- **Monaco Editor 0.52** ——代码编辑（VS Code 编辑器组件）
- **xterm.js 5.5 + node-pty 1.0** ——终端模拟器，WebGL 渲染
- **@earendil-works/pi 系列包** ——嵌入式编码代理运行时、提供商认证和扩展市场
- **pdf.js + mammoth** ——原生 PDF 和 DOCX 文档渲染
- **react-markdown + remark-gfm** ——Markdown 预览，GitHub 风格 Markdown
- **simple-git 3.27** ——Git 操作
- **chokidar 4.0** ——文件系统监视
- **@phosphor-icons/react** ——应用图标
- **Tailwind CSS 3.4** ——样式
- **electron-vite 5.0** ——打包与 HMR
- **electron-builder 26** ——打包和分发
- **electron-updater 6.8** ——更新检查
- **Sentry Electron 5** ——崩溃报告和诊断
- **Playwright** ——端到端集成测试
- **Vitest** ——单元测试运行器

## 路线图

Cate 正在积极开发中。有关每个版本的详细变更历史以及未来方向，请查看 [CHANGELOG](CHANGELOG.md)。

## Star 趋势

<a href="https://www.star-history.com/#0-AI-UG/cate&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
    <img alt="Star 趋势图" src="https://api.star-history.com/svg?repos=0-AI-UG/cate&type=Date" />
  </picture>
</a>

## 贡献

请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解贡献指南。

## 许可证

[MIT](LICENSE)
