# Sidebar Redesign: Live Terminal Intelligence

## Overview

Redesign the sidebar to show rich, live workspace information — Claude status, git branch, listening ports, and working directories — with an icon-only toolbar replacing the "WORKSPACES" header. macOS only (uses `lsof`, `ps`).

## Visual Layout

### Top Bar (Icon Toolbar)

Replaces the current "WORKSPACES" text header. Three icons, left to right:

| Icon | Action |
|------|--------|
| Panel toggle (layout icon) | Toggles file explorer visibility |
| Notification bell + badge | Badge shows count of workspaces where Claude needs input. Hidden when count is 0. |
| "+" button | Creates new workspace |

No text labels. Icons from lucide-react (`PanelLeft`, `Bell`, `Plus`).

### Workspace Card

Each workspace renders as a card. Selected workspace gets the workspace's own accent color as background (from `WORKSPACE_COLORS`). Layout:

```
┌──────────────────────────────────┐
│ ①  .../Dev/Apps/Canvas...    ×   │  ← panel count badge, truncated path, close
│ Claude is waiting for your input │  ← claude status text (conditional)
│ 🔔 Needs input                   │  ← status badge (conditional)
│ master* • ~/Dev/Apps/Canvas...   │  ← git branch + cwd
│ :3001, :5174                     │  ← listening ports (conditional)
└──────────────────────────────────┘
```

**Row details:**

1. **Title row**: Panel count badge (numbered circle, workspace accent color) on the left, workspace path truncated with `...` prefix showing last meaningful segments, close (×) button on right. No pin icon (deferred to future feature).
2. **Claude status text**: Only shown when Claude is running or waiting. Full text: "Claude is waiting for your input" / "Claude is running".
3. **Status badge**: Icon + short label. `Bell` icon + "Needs input" (orange) when Claude waiting. Only shown when Claude is in `waitingForInput` state. (Row 2 gives context, row 3 gives the actionable alert — both shown together for visual hierarchy matching the reference screenshot.)
4. **Info row**: Git branch name with `*` suffix when dirty, bullet separator, truncated CWD path. Hidden entirely if no git info AND no terminal CWD available.
5. **Ports row**: Comma-separated listening ports prefixed with `:`. Only shown when ports exist.

**Panel count badge**: Only shown when count > 0.

## Data Sources

### Port Scanning (New)

**Location**: Extend `src/main/ipc/shell.ts`

**Mechanism**: After each activity scan cycle (every 2 seconds), run a batched port scan:

```bash
lsof -iTCP -sTCP:LISTEN -P -n -F pn
```

Filter results to PIDs that are descendants of registered terminal shell PIDs. Parse port numbers. Group by terminal ID.

**IPC**: New channel `SHELL_PORTS_UPDATE` sends `{ terminalId: string, ports: number[] }` to renderer.

**Performance**: Single `lsof` call covers all terminals. Only runs when at least one terminal is registered. Coalesce with existing 2-second scan interval. Use async `execFile` (not `execSync`) to avoid blocking the main process, since `lsof` can be slow on systems with many open file descriptors.

### Git Status Tracking (New)

**Location**: New file `src/main/ipc/git-monitor.ts`

**Mechanism**: Per workspace with a `rootPath`, poll every 5 seconds:

```bash
git -C <rootPath> branch --show-current
git -C <rootPath> status --porcelain -uno | head -1
```

Branch name from first command. Dirty if second command produces any output.

**IPC**: New channel `GIT_BRANCH_UPDATE` sends `{ workspaceId: string, branch: string, isDirty: boolean }` to renderer.

**Lifecycle**: Renderer calls `GIT_MONITOR_START(workspaceId, rootPath)` when a workspace with a rootPath is created or when rootPath changes. Calls `GIT_MONITOR_STOP(workspaceId)` when workspace is removed. The main process maintains a `Map<workspaceId, intervalId>` to avoid duplicate monitors. All active workspaces with rootPaths are monitored simultaneously. When rootPath changes, stop old monitor, start new one.

### CWD Tracking (New)

**Location**: Extend `src/main/ipc/shell.ts`

**Mechanism**: During existing activity scan, also query CWD:

```bash
lsof -p <shellPid> -d cwd -Fn 2>/dev/null
```

Parse the `n` field for the directory path.

**IPC**: New channel `SHELL_CWD_UPDATE` sends `{ terminalId: string, cwd: string }` to renderer.

**Performance**: Runs per-terminal but uses lightweight `lsof` query. Included in existing 2-second scan cycle.

## Store Changes

### statusStore Extensions

```typescript
// Add to WorkspaceStatusState
listeningPorts: Record<string, number[]>      // terminalId → port numbers
terminalCwd: Record<string, string>           // terminalId → current working directory
terminalWorkspaceMap: Record<string, string>  // terminalId → workspaceId (populated on terminal creation)
gitInfo: Record<string, {                     // workspaceId → git info
  branch: string
  isDirty: boolean
}>
```

**Terminal-to-workspace mapping**: When a terminal is created, the renderer registers the mapping via `statusStore.registerTerminal(terminalId, workspaceId)`. When a terminal is closed, `statusStore.unregisterTerminal(terminalId)` cleans up. This mapping is used by the derived getters to aggregate per-workspace data.

New derived getters (standalone selector functions outside the store for proper Zustand subscriptions):

- `selectAllPorts(workspaceId)`: Aggregates ports across all terminals in workspace (using `terminalWorkspaceMap`), deduped and sorted.
- `selectPrimaryCwd(workspaceId)`: Returns CWD of the focused terminal (resolved via `canvasStore.focusedNodeId` → `appStore` panel lookup → terminalId), falling back to the first terminal with a CWD.
- `selectGitBranch(workspaceId)`: Returns branch + dirty status for workspace.

### statusStore Actions

- `registerTerminal(terminalId, workspaceId)`: Registers terminal-to-workspace mapping.
- `unregisterTerminal(terminalId)`: Removes terminal mapping and cleans up ports/cwd entries.
- `setTerminalPorts(terminalId, ports)`: Updates port list for terminal.
- `setTerminalCwd(terminalId, cwd)`: Updates CWD for terminal.
- `setGitInfo(workspaceId, branch, isDirty)`: Updates git info for workspace.

## Component Changes

### ProjectList.tsx

- Remove "WORKSPACES" header text.
- Replace with icon toolbar: `PanelLeft` | `Bell` (with badge) | `Plus`.
- Bell badge count = number of workspaces where Claude state is `waitingForInput`.

### WorkspaceTab.tsx

Complete rewrite to card layout:

- Accept enriched props from statusStore (ports, cwd, git info, claude state).
- Conditional rendering: Claude rows only when Claude active. Ports row only when ports exist.
- Path truncation: Show `.../<last-2-segments>` for long paths.
- Selected state: `bg-blue-600` background with white text.
- Unselected state: Default dark background, muted text.

### Sidebar.tsx

Minimal changes — container structure stays. May adjust padding/spacing for new card size.

### useProcessMonitor.ts

Extend to listen for new IPC channels:
- `SHELL_PORTS_UPDATE` → `statusStore.setTerminalPorts()`
- `SHELL_CWD_UPDATE` → `statusStore.setTerminalCwd()`
- `GIT_BRANCH_UPDATE` → `statusStore.setGitInfo()`

## IPC Channel Additions

Add to `src/shared/ipc-channels.ts`:

```typescript
SHELL_PORTS_UPDATE: 'shell:ports-update'
SHELL_CWD_UPDATE: 'shell:cwd-update'
GIT_BRANCH_UPDATE: 'git:branch-update'
GIT_MONITOR_START: 'git:monitor-start'
GIT_MONITOR_STOP: 'git:monitor-stop'
```

### Preload Method Signatures

```typescript
onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void
onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void
onGitBranchUpdate(callback: (workspaceId: string, branch: string, isDirty: boolean) => void): () => void
gitMonitorStart(workspaceId: string, rootPath: string): void
gitMonitorStop(workspaceId: string): void
```

## File Inventory

| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add 5 new channels |
| `src/shared/types.ts` | Add `GitInfo` interface |
| `src/shared/electron-api.d.ts` | Add type declarations for new IPC methods |
| `src/main/ipc/shell.ts` | Add async port scanning + CWD tracking to scan cycle |
| `src/main/ipc/git-monitor.ts` | New: git branch/dirty polling per workspace |
| `src/main/index.ts` | Register git-monitor IPC handlers |
| `src/preload/index.ts` | Expose new IPC channels |
| `src/renderer/stores/statusStore.ts` | Add ports, cwd, git state + terminal-workspace map + actions + selectors |
| `src/renderer/hooks/useProcessMonitor.ts` | Listen for new IPC events |
| `src/renderer/sidebar/ProjectList.tsx` | Icon toolbar replacing header |
| `src/renderer/sidebar/WorkspaceTab.tsx` | Full rewrite to card layout |
| `src/renderer/sidebar/Sidebar.tsx` | Padding/spacing adjustments for new card size |

## Edge Cases

- **No rootPath set**: Git info row hidden. Git monitor not started. CWD still tracked per terminal.
- **No terminals open**: No ports, no CWD, no Claude status. Card shows minimal info (just path + panel count).
- **Multiple terminals with ports**: Aggregate all ports across workspace terminals.
- **Terminal closed**: `unregisterTerminal()` cleans up ports, CWD, and mapping entries.
- **Git not installed**: `execFile` fails gracefully, show no git info.
- **Terminal exits mid-scan**: `lsof`/`ps` fail silently for dead PIDs, no crash.
- **Closing last workspace**: Existing `removeWorkspace` in appStore creates a new empty one — no change needed.
- **rootPath changes**: Stop old git monitor, start new one for updated path.
- **Bell badge at zero**: Badge hidden entirely (not shown as "0").
