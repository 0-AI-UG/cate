# Sidebar Redesign: Live Terminal Intelligence

## Overview

Redesign the sidebar to show rich, live workspace information — Claude status, git branch, listening ports, and working directories — with an icon-only toolbar replacing the "WORKSPACES" header.

## Visual Layout

### Top Bar (Icon Toolbar)

Replaces the current "WORKSPACES" text header. Three icons, left to right:

| Icon | Action |
|------|--------|
| Panel toggle (layout icon) | Toggles file explorer visibility |
| Notification bell + badge | Badge shows count of workspaces where Claude needs input |
| "+" button | Creates new workspace |

No text labels. Icons from lucide-react (`PanelLeft`, `Bell`, `Plus`).

### Workspace Card

Each workspace renders as a card. Selected workspace gets a blue highlight (`bg-blue-600`). Layout:

```
┌──────────────────────────────────┐
│ 📌  .../Dev/Apps/Canvas...    ×  │  ← pin icon, truncated path, close
│ Claude is waiting for your input │  ← claude status text (conditional)
│ 🔔 Needs input                   │  ← status badge (conditional)
│ master* • ~/Dev/Apps/Canvas...   │  ← git branch + cwd
│ :3001, :5174                     │  ← listening ports (conditional)
└──────────────────────────────────┘
```

**Row details:**

1. **Title row**: Pin icon (if workspace is pinned — future feature, always show for now), workspace path truncated with `...` prefix showing last meaningful segments, close (×) button on right.
2. **Claude status text**: Only shown when Claude is running or waiting. Full text: "Claude is waiting for your input" / "Claude is running" / "Claude has finished".
3. **Status badge**: Icon + short label. `Bell` icon + "Needs input" (orange) when Claude waiting. Only shown when actionable.
4. **Info row**: Git branch name with `*` suffix when dirty, bullet separator, truncated CWD path.
5. **Ports row**: Comma-separated listening ports prefixed with `:`. Only shown when ports exist.

**Panel count badge**: Numbered circle badge (workspace accent color) on the left side of the title, showing count of open panels in the workspace. Only shown when count > 0.

## Data Sources

### Port Scanning (New)

**Location**: Extend `src/main/ipc/shell.ts`

**Mechanism**: After each activity scan cycle (every 2 seconds), run a batched port scan:

```bash
lsof -iTCP -sTCP:LISTEN -P -n -F pn
```

Filter results to PIDs that are descendants of registered terminal shell PIDs. Parse port numbers. Group by terminal ID.

**IPC**: New channel `SHELL_PORTS_UPDATE` sends `{ terminalId: string, ports: number[] }` to renderer.

**Performance**: Single `lsof` call covers all terminals. Only runs when at least one terminal is registered. Coalesce with existing 2-second scan interval.

### Git Status Tracking (New)

**Location**: New file `src/main/ipc/git-monitor.ts`

**Mechanism**: Per workspace with a `rootPath`, poll every 5 seconds:

```bash
git -C <rootPath> branch --show-current
git -C <rootPath> status --porcelain -uno | head -1
```

Branch name from first command. Dirty if second command produces any output.

**IPC**: New channel `GIT_BRANCH_UPDATE` sends `{ workspaceId: string, branch: string, isDirty: boolean }` to renderer.

**Lifecycle**: Start monitoring when workspace is created/selected with a rootPath. Stop when workspace is removed. Avoid duplicate monitors for same path.

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
gitInfo: Record<string, {                     // workspaceId → git info
  branch: string
  isDirty: boolean
}>
```

New derived getters:

- `allPorts(workspaceId)`: Aggregates ports across all terminals in workspace, deduped and sorted.
- `primaryCwd(workspaceId)`: Returns CWD of the focused or most recently active terminal.
- `gitBranch(workspaceId)`: Returns branch + dirty status for workspace.

### statusStore Actions

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
```

## File Inventory

| File | Change |
|------|--------|
| `src/shared/ipc-channels.ts` | Add 3 new channels |
| `src/main/ipc/shell.ts` | Add port scanning + CWD tracking to scan cycle |
| `src/main/ipc/git-monitor.ts` | New: git branch/dirty polling per workspace |
| `src/main/index.ts` | Register git-monitor IPC handlers |
| `src/preload/index.ts` | Expose new IPC channels |
| `src/renderer/stores/statusStore.ts` | Add ports, cwd, git state + actions + getters |
| `src/renderer/hooks/useProcessMonitor.ts` | Listen for new IPC events |
| `src/renderer/sidebar/ProjectList.tsx` | Icon toolbar replacing header |
| `src/renderer/sidebar/WorkspaceTab.tsx` | Full rewrite to card layout |

## Edge Cases

- **No rootPath set**: Git info row shows nothing. CWD still tracked per terminal.
- **No terminals open**: No ports, no CWD, no Claude status. Card shows minimal info (just path + panel count).
- **Multiple terminals with ports**: Aggregate all ports across workspace terminals.
- **Terminal closed**: Clean up ports and CWD entries for that terminal ID.
- **Git not installed**: Gracefully handle command failure, show no git info.
