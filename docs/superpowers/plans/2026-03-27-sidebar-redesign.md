# Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the sidebar to show rich workspace cards with live terminal intelligence — Claude status, git branch, listening ports, and CWD — replacing the "WORKSPACES" header with an icon-only toolbar.

**Architecture:** Extend the main process shell monitor with async port scanning and CWD tracking. Add a new git-monitor module for per-workspace git branch polling. Extend statusStore with new state fields and selectors. Rewrite ProjectList and WorkspaceTab components for the new card layout.

**Tech Stack:** Electron IPC, React 18, Zustand, TypeScript, Tailwind CSS, lucide-react icons

**Spec:** `docs/superpowers/specs/2026-03-27-sidebar-redesign-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/shared/ipc-channels.ts` | Add 5 new IPC channel constants |
| `src/shared/types.ts` | Add `GitInfo` interface |
| `src/shared/electron-api.d.ts` | Type declarations for new IPC methods |
| `src/main/ipc/shell.ts` | Add async port scanning + CWD tracking to scan cycle |
| `src/main/ipc/git-monitor.ts` | New: git branch/dirty polling per workspace |
| `src/main/index.ts` | Register git-monitor handlers |
| `src/preload/index.ts` | Expose new IPC channels to renderer |
| `src/renderer/stores/statusStore.ts` | Add ports, cwd, git state, terminal-workspace map |
| `src/renderer/hooks/useProcessMonitor.ts` | Listen for 3 new IPC push channels |
| `src/renderer/sidebar/ProjectList.tsx` | Icon toolbar replacing header |
| `src/renderer/sidebar/WorkspaceTab.tsx` | Full rewrite to card layout |
| `src/renderer/sidebar/Sidebar.tsx` | Minor spacing adjustments |

---

### Task 1: IPC Channels + Shared Types

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/shared/types.ts`

- [ ] **Step 1: Add new IPC channel constants**

In `src/shared/ipc-channels.ts`, add after the existing `SHELL_ACTIVITY_UPDATE` line:

```typescript
export const SHELL_PORTS_UPDATE = 'shell:ports-update'       // main -> renderer
export const SHELL_CWD_UPDATE = 'shell:cwd-update'           // main -> renderer
```

And after the existing git channels:

```typescript
export const GIT_BRANCH_UPDATE = 'git:branch-update'         // main -> renderer
export const GIT_MONITOR_START = 'git:monitor-start'
export const GIT_MONITOR_STOP = 'git:monitor-stop'
```

- [ ] **Step 2: Add GitInfo type**

In `src/shared/types.ts`, add after the `TerminalActivity` type:

```typescript
export interface GitInfo {
  branch: string
  isDirty: boolean
}
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts src/shared/types.ts
git commit -m "feat: add IPC channels and GitInfo type for sidebar redesign"
```

---

### Task 2: Preload + Type Declarations

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/shared/electron-api.d.ts`

- [ ] **Step 1: Add new preload methods**

In `src/preload/index.ts`, add these imports to the import block:

```typescript
SHELL_PORTS_UPDATE,
SHELL_CWD_UPDATE,
GIT_BRANCH_UPDATE,
GIT_MONITOR_START,
GIT_MONITOR_STOP,
```

Add these methods inside the `contextBridge.exposeInMainWorld('electronAPI', {` object, after the existing shell methods:

```typescript
  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      ports: number[],
    ): void => {
      callback(terminalId, ports)
    }
    ipcRenderer.on(SHELL_PORTS_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_PORTS_UPDATE, listener)
    }
  },

  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      terminalId: string,
      cwd: string,
    ): void => {
      callback(terminalId, cwd)
    }
    ipcRenderer.on(SHELL_CWD_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(SHELL_CWD_UPDATE, listener)
    }
  },

  onGitBranchUpdate(
    callback: (workspaceId: string, branch: string, isDirty: boolean) => void,
  ): () => void {
    const listener = (
      _event: Electron.IpcRendererEvent,
      workspaceId: string,
      branch: string,
      isDirty: boolean,
    ): void => {
      callback(workspaceId, branch, isDirty)
    }
    ipcRenderer.on(GIT_BRANCH_UPDATE, listener)
    return () => {
      ipcRenderer.removeListener(GIT_BRANCH_UPDATE, listener)
    }
  },

  gitMonitorStart(workspaceId: string, rootPath: string): void {
    ipcRenderer.send(GIT_MONITOR_START, workspaceId, rootPath)
  },

  gitMonitorStop(workspaceId: string): void {
    ipcRenderer.send(GIT_MONITOR_STOP, workspaceId)
  },
```

- [ ] **Step 2: Update electron-api.d.ts**

Add to the `ElectronAPI` interface, after the existing shell methods:

```typescript
  /** Subscribe to port scan updates (main -> renderer). */
  onShellPortsUpdate(callback: (terminalId: string, ports: number[]) => void): () => void

  /** Subscribe to CWD updates (main -> renderer). */
  onShellCwdUpdate(callback: (terminalId: string, cwd: string) => void): () => void

  /** Subscribe to git branch updates (main -> renderer). */
  onGitBranchUpdate(
    callback: (workspaceId: string, branch: string, isDirty: boolean) => void,
  ): () => void

  /** Start git monitoring for a workspace. */
  gitMonitorStart(workspaceId: string, rootPath: string): void

  /** Stop git monitoring for a workspace. */
  gitMonitorStop(workspaceId: string): void
```

Also add `GitInfo` to the import line at the top.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts src/shared/electron-api.d.ts
git commit -m "feat: expose new IPC methods in preload and type declarations"
```

---

### Task 3: Port Scanning + CWD Tracking in Shell Monitor

**Files:**
- Modify: `src/main/ipc/shell.ts`

- [ ] **Step 1: Add async port scanning and CWD to the shell monitor**

Replace `import { execSync } from 'child_process'` with `import { execSync, execFile } from 'child_process'`.

Add these imports:

```typescript
import {
  SHELL_REGISTER_TERMINAL,
  SHELL_UNREGISTER_TERMINAL,
  SHELL_ACTIVITY_UPDATE,
  SHELL_PORTS_UPDATE,
  SHELL_CWD_UPDATE,
} from '../../shared/ipc-channels'
```

Add a helper to get all descendant PIDs (needed for port filtering):

```typescript
/**
 * Get all descendant PIDs of a process (recursive).
 */
function getAllDescendantPids(pid: number): number[] {
  const children = getChildPids(pid)
  const allDescendants = [...children]
  for (const child of children) {
    allDescendants.push(...getAllDescendantPids(child))
  }
  return allDescendants
}
```

Add async port scanning function:

```typescript
/**
 * Scan for listening TCP ports across all registered terminal process trees.
 * Uses async execFile to avoid blocking the main process.
 * Returns a map of terminalId → port numbers.
 */
function scanListeningPorts(): Promise<Map<string, number[]>> {
  return new Promise((resolve) => {
    if (registeredTerminals.size === 0) {
      resolve(new Map())
      return
    }

    // Build a set of all PIDs across all terminal process trees
    const pidToTerminal = new Map<number, string>()
    for (const [terminalId, info] of registeredTerminals) {
      const allPids = [info.shellPid, ...getAllDescendantPids(info.shellPid)]
      for (const pid of allPids) {
        pidToTerminal.set(pid, terminalId)
      }
    }

    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pn'], {
      timeout: 5000,
    }, (err, stdout) => {
      const result = new Map<string, number[]>()
      if (err || !stdout) {
        resolve(result)
        return
      }

      // Parse lsof -F output: p<pid>\nn<name> pairs
      let currentPid: number | null = null
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10)
        } else if (line.startsWith('n') && currentPid != null) {
          const terminalId = pidToTerminal.get(currentPid)
          if (terminalId) {
            // Parse port from address like "*:3001" or "127.0.0.1:5173"
            const match = line.match(/:(\d+)$/)
            if (match) {
              const port = parseInt(match[1], 10)
              if (!result.has(terminalId)) {
                result.set(terminalId, [])
              }
              const ports = result.get(terminalId)!
              if (!ports.includes(port)) {
                ports.push(port)
              }
            }
          }
        }
      }

      resolve(result)
    })
  })
}

/**
 * Get the current working directory of a process via lsof.
 */
function getProcessCwd(pid: number): string | null {
  if (!pid || pid <= 0) return null
  try {
    const output = execSync(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    for (const line of output.split('\n')) {
      if (line.startsWith('n') && line.length > 1) {
        return line.slice(1)
      }
    }
    return null
  } catch {
    return null
  }
}
```

- [ ] **Step 2: Extend the polling loop to emit port + CWD updates**

In the `startPolling` function, after the existing `for` loop that sends `SHELL_ACTIVITY_UPDATE`, add:

```typescript
      // --- CWD updates ---
      for (const [terminalId, info] of registeredTerminals) {
        const cwd = getProcessCwd(info.shellPid)
        if (cwd) {
          mainWindow.webContents.send(SHELL_CWD_UPDATE, terminalId, cwd)
        }
      }

      // --- Port scan (async, non-blocking) ---
      scanListeningPorts().then((portMap) => {
        if (mainWindow.isDestroyed()) return
        for (const [terminalId, ports] of portMap) {
          mainWindow.webContents.send(SHELL_PORTS_UPDATE, terminalId, ports.sort((a, b) => a - b))
        }
        // Also send empty ports for terminals with no ports
        for (const terminalId of registeredTerminals.keys()) {
          if (!portMap.has(terminalId)) {
            mainWindow.webContents.send(SHELL_PORTS_UPDATE, terminalId, [])
          }
        }
      })
```

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/shell.ts
git commit -m "feat: add async port scanning and CWD tracking to shell monitor"
```

---

### Task 4: Git Monitor Module

**Files:**
- Create: `src/main/ipc/git-monitor.ts`
- Modify: `src/main/index.ts`

- [ ] **Step 1: Create git-monitor.ts**

```typescript
// =============================================================================
// Git Monitor — polls git branch + dirty status per workspace
// =============================================================================

import { execFile } from 'child_process'
import { ipcMain, BrowserWindow } from 'electron'
import {
  GIT_BRANCH_UPDATE,
  GIT_MONITOR_START,
  GIT_MONITOR_STOP,
} from '../../shared/ipc-channels'

const POLL_INTERVAL_MS = 5000

// Active monitors: workspaceId → intervalId
const activeMonitors: Map<string, ReturnType<typeof setInterval>> = new Map()

// Last known state to avoid redundant updates
const lastState: Map<string, { branch: string; isDirty: boolean }> = new Map()

function pollGitStatus(
  mainWindow: BrowserWindow,
  workspaceId: string,
  rootPath: string,
): void {
  // Get branch name
  execFile('git', ['-C', rootPath, 'branch', '--show-current'], {
    timeout: 3000,
  }, (err, branchOut) => {
    if (err || mainWindow.isDestroyed()) return

    const branch = branchOut.trim()
    if (!branch) return

    // Check dirty status
    execFile('git', ['-C', rootPath, 'status', '--porcelain', '-uno'], {
      timeout: 3000,
    }, (err2, statusOut) => {
      if (err2 || mainWindow.isDestroyed()) return

      const isDirty = statusOut.trim().length > 0

      // Only send update if state changed
      const prev = lastState.get(workspaceId)
      if (prev && prev.branch === branch && prev.isDirty === isDirty) return

      lastState.set(workspaceId, { branch, isDirty })
      mainWindow.webContents.send(GIT_BRANCH_UPDATE, workspaceId, branch, isDirty)
    })
  })
}

export function registerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.on(GIT_MONITOR_START, (_event, workspaceId: string, rootPath: string) => {
    // Stop existing monitor for this workspace if any
    const existing = activeMonitors.get(workspaceId)
    if (existing) {
      clearInterval(existing)
    }

    // Poll immediately, then on interval
    pollGitStatus(mainWindow, workspaceId, rootPath)
    const interval = setInterval(() => {
      pollGitStatus(mainWindow, workspaceId, rootPath)
    }, POLL_INTERVAL_MS)

    activeMonitors.set(workspaceId, interval)
  })

  ipcMain.on(GIT_MONITOR_STOP, (_event, workspaceId: string) => {
    const interval = activeMonitors.get(workspaceId)
    if (interval) {
      clearInterval(interval)
      activeMonitors.delete(workspaceId)
    }
    lastState.delete(workspaceId)
  })
}
```

- [ ] **Step 2: Register in main/index.ts**

Add import:

```typescript
import { registerHandlers as registerGitMonitorHandlers } from './ipc/git-monitor'
```

Add after `registerShellHandlers(mainWindow)`:

```typescript
  registerGitMonitorHandlers(mainWindow)
```

- [ ] **Step 3: Commit**

```bash
git add src/main/ipc/git-monitor.ts src/main/index.ts
git commit -m "feat: add git monitor for per-workspace branch/dirty polling"
```

---

### Task 5: Extend statusStore

**Files:**
- Modify: `src/renderer/stores/statusStore.ts`

- [ ] **Step 1: Add new state fields and actions**

Add `GitInfo` to the imports from `../../shared/types`.

Extend `WorkspaceStatusState` interface:

```typescript
interface WorkspaceStatusState {
  terminalActivity: Record<string, TerminalActivity>
  claudeCodeState: Record<string, ClaudeCodeState>
  nodeActivity: Record<CanvasNodeId, NodeActivityState>
  terminalTitles: Record<string, string>
  listeningPorts: Record<string, number[]>      // terminalId → ports
  terminalCwd: Record<string, string>            // terminalId → cwd
}
```

Update `emptyWorkspaceStatus()`:

```typescript
function emptyWorkspaceStatus(): WorkspaceStatusState {
  return {
    terminalActivity: {},
    claudeCodeState: {},
    nodeActivity: {},
    terminalTitles: {},
    listeningPorts: {},
    terminalCwd: {},
  }
}
```

Add to `StatusStoreState`:

```typescript
  /** Terminal → workspace mapping. */
  terminalWorkspaceMap: Record<string, string>
  /** Per-workspace git info. */
  gitInfo: Record<string, GitInfo>
```

Add to `StatusStoreActions`:

```typescript
  registerTerminal: (terminalId: string, workspaceId: string) => void
  unregisterTerminal: (terminalId: string) => void
  setTerminalPorts: (terminalId: string, ports: number[]) => void
  setTerminalCwd: (terminalId: string, cwd: string) => void
  setGitInfo: (workspaceId: string, branch: string, isDirty: boolean) => void
```

Initialize new state in the store creator:

```typescript
  terminalWorkspaceMap: {},
  gitInfo: {},
```

Add new action implementations:

```typescript
  registerTerminal(terminalId, workspaceId) {
    set((state) => ({
      terminalWorkspaceMap: { ...state.terminalWorkspaceMap, [terminalId]: workspaceId },
    }))
  },

  unregisterTerminal(terminalId) {
    set((state) => {
      const { [terminalId]: _removed, ...remainingMap } = state.terminalWorkspaceMap

      // Clean up ports and cwd from the workspace
      const workspaceId = state.terminalWorkspaceMap[terminalId]
      const updatedWorkspaces = { ...state.workspaces }
      if (workspaceId && updatedWorkspaces[workspaceId]) {
        const ws = updatedWorkspaces[workspaceId]
        const { [terminalId]: _p, ...remainingPorts } = ws.listeningPorts
        const { [terminalId]: _c, ...remainingCwd } = ws.terminalCwd
        const { [terminalId]: _a, ...remainingActivity } = ws.terminalActivity
        const { [terminalId]: _s, ...remainingClaude } = ws.claudeCodeState
        const { [terminalId]: _t, ...remainingTitles } = ws.terminalTitles
        updatedWorkspaces[workspaceId] = {
          ...ws,
          listeningPorts: remainingPorts,
          terminalCwd: remainingCwd,
          terminalActivity: remainingActivity,
          claudeCodeState: remainingClaude,
          terminalTitles: remainingTitles,
        }
      }

      return {
        terminalWorkspaceMap: remainingMap,
        workspaces: updatedWorkspaces,
      }
    })
  },

  setTerminalPorts(terminalId, ports) {
    set((state) => {
      const workspaceId = state.terminalWorkspaceMap[terminalId]
      if (!workspaceId) return state
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            listeningPorts: { ...ws.listeningPorts, [terminalId]: ports },
          },
        },
      }
    })
  },

  setTerminalCwd(terminalId, cwd) {
    set((state) => {
      const workspaceId = state.terminalWorkspaceMap[terminalId]
      if (!workspaceId) return state
      const ws = state.workspaces[workspaceId] ?? emptyWorkspaceStatus()
      return {
        workspaces: {
          ...state.workspaces,
          [workspaceId]: {
            ...ws,
            terminalCwd: { ...ws.terminalCwd, [terminalId]: cwd },
          },
        },
      }
    })
  },

  setGitInfo(workspaceId, branch, isDirty) {
    set((state) => ({
      gitInfo: { ...state.gitInfo, [workspaceId]: { branch, isDirty } },
    }))
  },
```

- [ ] **Step 2: Add standalone selector functions (exported)**

Add outside the store, at the bottom of the file:

```typescript
// =============================================================================
// Standalone selectors for proper Zustand subscriptions
// =============================================================================

/** Aggregate all listening ports across terminals in a workspace. */
export function selectAllPorts(workspaceId: string): number[] {
  const state = useStatusStore.getState()
  const ws = state.workspaces[workspaceId]
  if (!ws) return []

  const allPorts = new Set<number>()
  // Find all terminals belonging to this workspace
  for (const [terminalId, wsId] of Object.entries(state.terminalWorkspaceMap)) {
    if (wsId === workspaceId && ws.listeningPorts[terminalId]) {
      for (const port of ws.listeningPorts[terminalId]) {
        allPorts.add(port)
      }
    }
  }
  return Array.from(allPorts).sort((a, b) => a - b)
}

/** Get the CWD of the first terminal with a CWD in the workspace. */
export function selectPrimaryCwd(workspaceId: string): string | null {
  const state = useStatusStore.getState()
  const ws = state.workspaces[workspaceId]
  if (!ws) return null

  for (const [terminalId, wsId] of Object.entries(state.terminalWorkspaceMap)) {
    if (wsId === workspaceId && ws.terminalCwd[terminalId]) {
      return ws.terminalCwd[terminalId]
    }
  }
  return null
}

/** Get git branch info for a workspace. */
export function selectGitInfo(workspaceId: string): { branch: string; isDirty: boolean } | null {
  return useStatusStore.getState().gitInfo[workspaceId] ?? null
}
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/stores/statusStore.ts
git commit -m "feat: extend statusStore with ports, cwd, git info, and terminal mapping"
```

---

### Task 6: Extend useProcessMonitor Hook

**Files:**
- Modify: `src/renderer/hooks/useProcessMonitor.ts`

- [ ] **Step 1: Add listeners for new IPC channels**

Add new `useEffect` blocks inside the `useProcessMonitor` function, after the existing `useEffect`:

```typescript
  // --- Port updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellPortsUpdate) return

    const unsubscribe = api.onShellPortsUpdate((terminalId: string, ports: number[]) => {
      useStatusStore.getState().setTerminalPorts(terminalId, ports)
    })

    return () => { unsubscribe() }
  }, [])

  // --- CWD updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onShellCwdUpdate) return

    const unsubscribe = api.onShellCwdUpdate((terminalId: string, cwd: string) => {
      useStatusStore.getState().setTerminalCwd(terminalId, cwd)
    })

    return () => { unsubscribe() }
  }, [])

  // --- Git branch updates ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onGitBranchUpdate) return

    const unsubscribe = api.onGitBranchUpdate(
      (workspaceId: string, branch: string, isDirty: boolean) => {
        useStatusStore.getState().setGitInfo(workspaceId, branch, isDirty)
      },
    )

    return () => { unsubscribe() }
  }, [])
```

- [ ] **Step 2: Add terminal registration call**

At the beginning of the existing `useEffect` (the one with the `onShellActivityUpdate` listener), after setting up the listener, register the terminal-workspace mapping. Actually, this hook doesn't know the terminal IDs yet — they're registered elsewhere. Instead, add the registration call to wherever terminals are created in the renderer.

Look at how `shellRegisterTerminal` is called (likely in `TerminalPanel.tsx`). The `registerTerminal` statusStore action should be called right after `shellRegisterTerminal` is called, passing the `workspaceId`. Find the terminal panel and add:

```typescript
useStatusStore.getState().registerTerminal(terminalId, workspaceId)
```

Similarly, when a terminal is closed (on cleanup), add:

```typescript
useStatusStore.getState().unregisterTerminal(terminalId)
```

Note to implementer: Find where `shellRegisterTerminal` is called in `TerminalPanel.tsx` and add the `registerTerminal` call there. The workspaceId should be available from the component's props or from `useAppStore`.

- [ ] **Step 3: Start git monitor when workspace has rootPath**

Add a new `useEffect` to `useProcessMonitor`:

```typescript
  // --- Start git monitor for workspace ---
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.gitMonitorStart) return

    // Get rootPath from appStore
    const ws = useAppStore.getState().getWorkspace(workspaceId)
    if (ws?.rootPath) {
      api.gitMonitorStart(workspaceId, ws.rootPath)
    }

    return () => {
      api.gitMonitorStop?.(workspaceId)
    }
  }, [workspaceId])
```

Add import for `useAppStore`:

```typescript
import { useAppStore } from '../stores/appStore'
```

- [ ] **Step 4: Commit**

```bash
git add src/renderer/hooks/useProcessMonitor.ts
git commit -m "feat: extend useProcessMonitor with port, cwd, and git listeners"
```

---

### Task 7: Rewrite ProjectList with Icon Toolbar

**Files:**
- Modify: `src/renderer/sidebar/ProjectList.tsx`

- [ ] **Step 1: Rewrite ProjectList.tsx**

Replace the entire component with:

```tsx
import React from 'react'
import { PanelLeft, Bell, Plus } from 'lucide-react'
import { useAppStore } from '../stores/appStore'
import { useStatusStore } from '../stores/statusStore'
import { WorkspaceTab } from './WorkspaceTab'

export const ProjectList: React.FC = () => {
  const workspaces = useAppStore((s) => s.workspaces)
  const selectedWorkspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const addWorkspace = useAppStore((s) => s.addWorkspace)
  const selectWorkspace = useAppStore((s) => s.selectWorkspace)
  const removeWorkspace = useAppStore((s) => s.removeWorkspace)

  // Count workspaces with Claude waiting for input
  const needsInputCount = useStatusStore((s) => {
    let count = 0
    for (const ws of workspaces) {
      if (s.isAnimating(ws.id)) count++
    }
    return count
  })

  return (
    <div className="flex flex-col h-full">
      {/* Icon toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 flex-shrink-0">
        <button
          className="text-white/40 hover:text-white/70 transition-colors p-1"
          title="Toggle File Explorer"
        >
          <PanelLeft size={16} />
        </button>

        <button
          className="relative text-white/40 hover:text-white/70 transition-colors p-1"
          title="Notifications"
        >
          <Bell size={16} />
          {needsInputCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
              {needsInputCount}
            </span>
          )}
        </button>

        <button
          className="text-white/40 hover:text-white/70 transition-colors p-1"
          onClick={() => addWorkspace()}
          title="New Workspace"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Scrollable workspace list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        <div className="flex flex-col gap-1.5">
          {workspaces.map((ws) => (
            <WorkspaceTab
              key={ws.id}
              workspace={ws}
              isSelected={ws.id === selectedWorkspaceId}
              onClick={() => selectWorkspace(ws.id)}
              onClose={() => removeWorkspace(ws.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/sidebar/ProjectList.tsx
git commit -m "feat: replace workspace header with icon toolbar in ProjectList"
```

---

### Task 8: Rewrite WorkspaceTab as Rich Card

**Files:**
- Modify: `src/renderer/sidebar/WorkspaceTab.tsx`

- [ ] **Step 1: Rewrite WorkspaceTab.tsx**

Replace the entire file with:

```tsx
import React from 'react'
import { Bell, X } from 'lucide-react'
import type { WorkspaceState } from '../../shared/types'
import { useStatusStore, selectAllPorts, selectPrimaryCwd, selectGitInfo } from '../stores/statusStore'

// Pulse animation styles
const PULSE_KEYFRAMES = `
@keyframes sidebar-pulse-ring {
  0%   { transform: scale(1);   opacity: 0.6; }
  100% { transform: scale(2.2); opacity: 0; }
}
`
let stylesInjected = false
function ensurePulseStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = PULSE_KEYFRAMES
  document.head.appendChild(style)
}

/** Truncate a path to show .../<last-2-segments> */
function truncatePath(fullPath: string): string {
  if (!fullPath) return ''
  const segments = fullPath.split('/').filter(Boolean)
  if (segments.length <= 2) return fullPath
  return '.../' + segments.slice(-2).join('/')
}

/** Shorten home directory prefix to ~ */
function shortenHome(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (home && path.startsWith(home)) {
    return '~' + path.slice(home.length)
  }
  return path
}

interface WorkspaceTabProps {
  workspace: WorkspaceState
  isSelected: boolean
  onClick: () => void
  onClose: () => void
}

export const WorkspaceTab: React.FC<WorkspaceTabProps> = ({
  workspace,
  isSelected,
  onClick,
  onClose,
}) => {
  ensurePulseStyles()

  const statusText = useStatusStore((s) => s.statusText(workspace.id))
  const isAnimating = useStatusStore((s) => s.isAnimating(workspace.id))
  const statusColor = useStatusStore((s) => s.statusColor(workspace.id))

  // Use getState() for derived selectors to avoid re-render issues
  const ports = useStatusStore(() => selectAllPorts(workspace.id))
  const cwd = useStatusStore(() => selectPrimaryCwd(workspace.id))
  const gitInfo = useStatusStore(() => selectGitInfo(workspace.id))

  const panelCount = Object.keys(workspace.panels).length
  const claudeState = useStatusStore((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return 'notRunning'
    const vals = Object.values(ws.claudeCodeState)
    if (vals.includes('waitingForInput')) return 'waitingForInput'
    if (vals.includes('running')) return 'running'
    if (vals.includes('finished')) return 'finished'
    return 'notRunning'
  })

  const showClaudeStatus = claudeState === 'running' || claudeState === 'waitingForInput'
  const showNeedsInput = claudeState === 'waitingForInput'

  const displayPath = truncatePath(workspace.rootPath || workspace.name)
  const displayCwd = cwd ? shortenHome(cwd) : null
  const displayCwdTruncated = displayCwd ? truncatePath(displayCwd) : null

  // Git display
  const gitDisplay = gitInfo
    ? `${gitInfo.branch}${gitInfo.isDirty ? '*' : ''}`
    : null

  // Info row: git branch + cwd
  const hasInfoRow = gitDisplay || displayCwdTruncated

  return (
    <div
      className={`relative rounded-lg cursor-pointer transition-colors px-3 py-2.5 ${
        isSelected
          ? 'text-white'
          : 'hover:bg-white/[0.05] text-white/80'
      }`}
      style={isSelected ? { backgroundColor: workspace.color } : undefined}
      onClick={onClick}
    >
      {/* Row 1: Badge + Path + Close */}
      <div className="flex items-center gap-2">
        {/* Panel count badge */}
        {panelCount > 0 && (
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center text-white"
            style={{ backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : workspace.color }}
          >
            {panelCount}
          </span>
        )}

        <span className="flex-1 min-w-0 text-sm font-semibold truncate">
          {displayPath}
        </span>

        <button
          className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="Close Workspace"
        >
          <X size={14} />
        </button>
      </div>

      {/* Row 2: Claude status text */}
      {showClaudeStatus && (
        <div className="mt-1 text-xs opacity-80">
          {claudeState === 'waitingForInput'
            ? 'Claude is waiting for your input'
            : 'Claude is running'}
        </div>
      )}

      {/* Row 3: Needs input badge */}
      {showNeedsInput && (
        <div className="mt-1 flex items-center gap-1 text-xs">
          <Bell size={12} className="text-orange-400" />
          <span className="text-orange-400 font-medium">Needs input</span>
        </div>
      )}

      {/* Row 4: Git branch + CWD */}
      {hasInfoRow && (
        <div className="mt-1 text-[11px] opacity-60 truncate">
          {gitDisplay && <span>{gitDisplay}</span>}
          {gitDisplay && displayCwdTruncated && <span> &bull; </span>}
          {displayCwdTruncated && <span>{displayCwdTruncated}</span>}
        </div>
      )}

      {/* Row 5: Listening ports */}
      {ports.length > 0 && (
        <div className="mt-0.5 text-[11px] opacity-60">
          {ports.map((p) => `:${p}`).join(', ')}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/sidebar/WorkspaceTab.tsx
git commit -m "feat: rewrite WorkspaceTab as rich card with live terminal info"
```

---

### Task 9: Terminal Registration + Sidebar Cleanup

**Files:**
- Modify: `src/renderer/panels/TerminalPanel.tsx` (add terminal-workspace registration)
- Modify: `src/renderer/sidebar/Sidebar.tsx` (minor spacing)

- [ ] **Step 1: Add terminal-workspace registration**

Find where `shellRegisterTerminal` is called in `TerminalPanel.tsx`. Right after that call, add:

```typescript
import { useStatusStore } from '../stores/statusStore'
// ... inside the component or effect where shellRegisterTerminal is called:
useStatusStore.getState().registerTerminal(terminalId, workspaceId)
```

On cleanup (where `shellUnregisterTerminal` is called), add:

```typescript
useStatusStore.getState().unregisterTerminal(terminalId)
```

The `workspaceId` should come from `useAppStore` — find the current workspace ID from the component's context. If not directly available, get it via `useAppStore.getState().selectedWorkspaceId`.

- [ ] **Step 2: Remove the footer toggle from Sidebar.tsx**

The "Hide Explorer" / "Show Explorer" button in the footer is replaced by the `PanelLeft` icon in the toolbar. Wire the `PanelLeft` button in `ProjectList.tsx` to toggle the file explorer.

In `Sidebar.tsx`, expose the `setShowFileExplorer` toggle via a callback prop or shared state. The simplest approach: lift the `showFileExplorer` toggle into the `ProjectList` by having the `PanelLeft` button call a callback passed from `Sidebar`.

Update `ProjectList` to accept an `onToggleFileExplorer` prop:

```tsx
interface ProjectListProps {
  onToggleFileExplorer?: () => void
}
```

Wire the `PanelLeft` button's `onClick` to `onToggleFileExplorer`.

In `Sidebar.tsx`, pass the toggle:

```tsx
<ProjectList onToggleFileExplorer={() => setShowFileExplorer((prev) => !prev)} />
```

Remove the footer `div` with "Hide Explorer" / "Show Explorer" button.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/panels/TerminalPanel.tsx src/renderer/sidebar/Sidebar.tsx src/renderer/sidebar/ProjectList.tsx
git commit -m "feat: wire terminal registration and sidebar file explorer toggle"
```

---

### Task 10: Build Verification

- [ ] **Step 1: Run TypeScript build check**

```bash
cd canvas-ide && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Run dev server**

```bash
cd canvas-ide && npm run dev
```

Verify the app launches, sidebar shows the new card layout, and there are no console errors.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "fix: resolve build errors from sidebar redesign"
```
