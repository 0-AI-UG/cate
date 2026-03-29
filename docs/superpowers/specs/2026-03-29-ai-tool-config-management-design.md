# AI Tool Configuration Management — Design Spec

**Date**: 2026-03-29
**Status**: Approved

## Problem

CanvasIDE users work with multiple AI coding CLI tools (Claude Code, OpenAI Codex, Gemini CLI, Cursor, OpenCode) that each require their own configuration files. Currently there's no way to manage these configs from within CanvasIDE — users must manually create CLAUDE.md, AGENTS.md, .mcp.json, etc. This friction slows down project setup and makes it harder to maintain consistent AI tool configurations.

## Goal

Make CanvasIDE the best IDE for AI-assisted coding by providing first-class configuration management for all major AI coding tools — detecting what's configured, scaffolding missing configs, managing MCP servers, and surfacing status across the UI.

## Supported Tools

| Tool | Config Files |
|------|-------------|
| Claude Code | `CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills/`, `.mcp.json` |
| OpenAI Codex | `AGENTS.md`, `.codex/config.toml`, `.codex/hooks.json` |
| Gemini CLI | `GEMINI.md` |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules` |
| OpenCode | `OPENCODE.md` (evolving standard) |

## Architecture

### Central Store Pattern

A dedicated `aiConfigStore` (Zustand) holds all AI tool configuration state and feeds every UI surface. This avoids duplicate scanning and enables reactive updates when config files change externally.

```
┌──────────────────────────────────────────────────────┐
│                   aiConfigStore                       │
│  tools: Record<AIToolId, AIToolPresence>              │
│  mcpServers: Record<string, MCPServerConfig>          │
│  scanning: boolean                                    │
├──────────────────────────────────────────────────────┤
│  scanWorkspace() ──► scanner.ts ──► fsReadDir/fsStat  │
│  createConfig()  ──► templates.ts ──► fsWriteFile     │
│  loadMcpServers() ──► mcpConfig.ts ──► fsReadFile     │
│  spawnMcpServer() ──► IPC ──► main/ipc/mcp.ts         │
└──────────────────────────────────────────────────────┘
         │              │             │            │
    AIConfigPanel  SidebarTab  WelcomePage  SetupDialog
```

### Config Strategy

Each tool's native config files are managed independently — no universal format or abstraction layer. CanvasIDE reads and writes the exact files each tool expects.

---

## Phase 1: Detection + Dashboard Panel

### New Types

```ts
// src/shared/types.ts
type AIToolId = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode'

interface AIToolPresence {
  id: AIToolId
  name: string
  detected: boolean
  configFiles: { path: string; exists: boolean; description: string }[]
}

// Extend PanelType union
type PanelType = ... | 'aiConfig'
```

### Scanner Module

`src/renderer/lib/aiConfig/scanner.ts` — pure async function that checks for known config file paths using existing `fsStat` IPC. Returns `Record<AIToolId, AIToolPresence>`.

**Error handling**: `fsStat` throws when a path does not exist. The scanner must catch rejections and treat them as `exists: false`. Only unexpected errors (permissions, etc.) should propagate.

### AI Config Store

`src/renderer/stores/aiConfigStore.ts` — Zustand store with:
- `tools` state populated by scanner
- `scanWorkspace(rootPath)` action
- Auto-scan on workspace root change

### AI Config Panel

`src/renderer/panels/AIConfigPanel.tsx` — new canvas panel showing:
- Card per tool with status badge (Configured / Partial / Not configured)
- Per-file exists/missing indicators
- "Open" button for existing files (opens EditorPanel)
- "Create" button for missing files (Phase 2)

### App Store Integration

Add `createAIConfig()` to `appStore.ts` following existing `createGit()` pattern. Register in `panelIcon()`, `panelColor()`, `PANEL_DEFAULT_SIZES`, `PANEL_MINIMUM_SIZES`.

### Files

| Action | Path | Notes |
|--------|------|-------|
| Modify | `src/shared/types.ts` | Add AIToolId, AIToolPresence, extend PanelType, add PANEL_DEFAULT_SIZES/PANEL_MINIMUM_SIZES entries |
| Modify | `src/renderer/stores/appStore.ts` | Add createAIConfig() method |
| Modify | `src/renderer/canvas/CanvasNode.tsx` | Add panel rendering case |
| Modify | `src/renderer/panels/types.ts` | Add to panelIcon() and panelColor() switches |
| Modify | `src/renderer/canvas/CanvasNodeTitleBar.tsx` | Add to PanelIcon switch |
| Modify | `src/renderer/App.tsx` | Add to renderPanelContent and onCreateAtPoint switches |
| Create | `src/renderer/stores/aiConfigStore.ts` | |
| Create | `src/renderer/lib/aiConfig/scanner.ts` | |
| Create | `src/renderer/panels/AIConfigPanel.tsx` | |

---

## Phase 2: Config File Templates

### Template Module

`src/renderer/lib/aiConfig/templates.ts` — export per-tool template functions:
- `getClaudeMdTemplate(projectName)` — sections for overview, build, architecture
- `getAgentsMdTemplate(projectName)` — repository expectations, dev environment, testing
- `getGeminiMdTemplate(projectName)` — general instructions, coding style
- `getCursorRulesTemplate(projectName)` — .mdc format with frontmatter
- `getClaudeSettingsTemplate()` — JSON with sensible permission defaults
- `getMcpJsonTemplate()` — `{ "mcpServers": {} }`

Templates are context-aware: the `createConfig()` store action reads `package.json` and `tsconfig.json` via `fsReadFile` before calling template functions, passing the parsed content as parameters. Template functions themselves are pure (no IPC calls).

### Store Action

`createConfig(toolId, fileType, rootPath)` — reads project context files via `fsReadFile`, calls template function with parsed data, writes result via `fsWriteFile`, then re-scans to update UI.

### UI

- "Create" buttons per missing file
- "Create All for [tool]" bulk action
- Inline success feedback

### Files

| Action | Path |
|--------|------|
| Create | `src/renderer/lib/aiConfig/templates.ts` |
| Modify | `src/renderer/stores/aiConfigStore.ts` |
| Modify | `src/renderer/panels/AIConfigPanel.tsx` |

---

## Phase 3: MCP Server Management

### New Types

```ts
// src/shared/types.ts

// Static config persisted to .mcp.json
interface MCPServerDefinition {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
}

// Runtime state (definition + lifecycle status) — NOT persisted
interface MCPServerConfig extends MCPServerDefinition {
  status: 'stopped' | 'starting' | 'running' | 'error'
  error?: string
}
```

`serializeMcpJson()` accepts `MCPServerDefinition[]` (strips runtime fields). `parseMcpJson()` returns `MCPServerDefinition[]` (status defaults to `'stopped'`).

### IPC Channels

```ts
// src/shared/ipc-channels.ts
export const MCP_SPAWN = 'mcp:spawn'
export const MCP_STOP = 'mcp:stop'
export const MCP_TEST = 'mcp:test'
export const MCP_STATUS_UPDATE = 'mcp:statusUpdate'
```

### Main Process Handler

`src/main/ipc/mcp.ts` — manages MCP server child processes:
- Spawn servers as child processes, track PIDs
- Kill servers by name
- Test connections via init handshake (JSON-RPC 2.0)
- Push status updates to renderer via `MCP_STATUS_UPDATE`
- Pattern: follow `src/main/ipc/shell.ts` for process management

### Config Parser

`src/renderer/lib/aiConfig/mcpConfig.ts`:
- `parseMcpJson(content)` — parse `.mcp.json` format
- `serializeMcpJson(servers)` — write back

### Store Extensions

Add to `aiConfigStore`: `mcpServers` state, load/add/remove/update/spawn/stop/test actions.

### Panel UI

MCP section in AIConfigPanel:
- Server list with status indicators (green/red/gray dots)
- Add form: name, command, args, env vars (key-value with secret toggle)
- Per-server: Start, Stop, Test, Edit, Remove buttons

### Files

| Action | Path |
|--------|------|
| Create | `src/main/ipc/mcp.ts` |
| Create | `src/renderer/lib/aiConfig/mcpConfig.ts` |
| Modify | `src/shared/types.ts` |
| Modify | `src/shared/ipc-channels.ts` |
| Modify | `src/preload/index.ts` |
| Modify | `src/shared/electron-api.d.ts` |
| Modify | `src/renderer/stores/aiConfigStore.ts` |
| Modify | `src/renderer/panels/AIConfigPanel.tsx` |
| Modify | `src/main/index.ts` |

---

## Phase 4: Multi-Surface UI

### Sidebar Tab

`src/renderer/sidebar/AIConfigSidebarTab.tsx`:
- Compact tool icons with status dots
- Quick actions: open panel, create missing configs
- MCP server status summary
- Register in the sidebar tab system via `src/renderer/sidebar/RightSidebar.tsx` (or equivalent sidebar host component that manages tab rendering)

### Welcome Page

Modify `src/renderer/panels/ProjectListPanel.tsx` (the welcome/project-list page):
- "AI Tools" card showing readiness per recent project
- "Set up AI tools" button → opens panel or dialog

### Settings Section

- Default template preferences (which tools to auto-scaffold)
- Global MCP server configurations
- AI tool binary path overrides

### Setup Dialog

`src/renderer/dialogs/AISetupDialog.tsx` — wizard:
1. Detect installed CLI tools on system (`which claude`, `which codex`, etc.)
2. Select tools to configure
3. Customize templates
4. Create files + summary

### Files

| Action | Path |
|--------|------|
| Create | `src/renderer/sidebar/AIConfigSidebarTab.tsx` |
| Create | `src/renderer/dialogs/AISetupDialog.tsx` |
| Modify | `src/renderer/panels/ProjectListPanel.tsx` (welcome page) |
| Modify | `src/renderer/sidebar/RightSidebar.tsx` (sidebar tab host) |
| Modify | `src/renderer/stores/uiStore.ts` |

---

## Phase 5: Config Editing + Validation

### Per-Tool Parsers

- `src/renderer/lib/aiConfig/claudeConfig.ts` — parse `.claude/settings.json`
- `src/renderer/lib/aiConfig/codexConfig.ts` — parse `.codex/config.toml`
- `src/renderer/lib/aiConfig/cursorConfig.ts` — parse `.cursor/rules/*.mdc`

### Structured Editors

- Claude: permissions editor (allow/deny lists), hooks, env vars
- Cursor: list .mdc files with name/description/globs, create new rules
- Markdown configs: "Open in Editor" → EditorPanel with Monaco

### Validation

- JSON Schema for `.claude/settings.json` and `.mcp.json`
- TOML parsing for `.codex/config.toml`
- Inline error display
- File watching via `fsWatchStart` for external changes → store updates

### Files

| Action | Path |
|--------|------|
| Create | `src/renderer/lib/aiConfig/claudeConfig.ts` |
| Create | `src/renderer/lib/aiConfig/codexConfig.ts` |
| Create | `src/renderer/lib/aiConfig/cursorConfig.ts` |
| Modify | `src/renderer/stores/aiConfigStore.ts` (add file watching, parsed config state) |
| Modify | `src/renderer/panels/AIConfigPanel.tsx` (add structured edit views) |

---

## Phase 6: MCP Registry (Stretch)

### Registry Data

`src/renderer/lib/aiConfig/mcpRegistry.ts` + `assets/mcp-registry.json`:
- Curated catalog of popular MCP servers
- Fields: name, description, npm package, command, args, required env vars, category
- Optional remote fetch for updates

### Registry UI

- Browse/search by category in AIConfigPanel
- One-click install → adds to `.mcp.json` with env var wizard
- Shows which servers are already configured

### Files

| Action | Path |
|--------|------|
| Create | `src/renderer/lib/aiConfig/mcpRegistry.ts` |
| Create | `assets/mcp-registry.json` |
| Modify | `src/renderer/panels/AIConfigPanel.tsx` (add registry browser tab) |

---

## Existing Patterns to Reuse

| What | Where |
|------|-------|
| PanelType registration | `src/shared/types.ts:29` |
| Panel creation method | `appStore.ts` (createGit, createAIChat) |
| IPC channel constants | `src/shared/ipc-channels.ts` |
| Child process management | `src/main/ipc/shell.ts` |
| File read/write/stat | electronAPI.fsReadFile/fsWriteFile/fsStat |
| File watching | electronAPI.fsWatchStart/fsWatchStop |
| Zustand store pattern | `src/renderer/stores/canvasStore.ts` |
| Sidebar tab pattern | `src/renderer/sidebar/WorkspaceTab.tsx` |

## Verification

Per phase:
1. `npm run dev` — no errors
2. Phase 1: AI Config Panel shows correct detection for all tools
3. Phase 2: Create buttons generate valid config files
4. Phase 3: MCP spawn/stop/test works, status updates in real-time
5. Phase 4: All UI surfaces show consistent state
6. Phase 5: Structured editors save valid configs, validation works
7. Phase 6: Registry loads, install works

Smoke test: Open this CanvasIDE repo, verify it detects existing `CLAUDE.md` and `.claude/` directory.
