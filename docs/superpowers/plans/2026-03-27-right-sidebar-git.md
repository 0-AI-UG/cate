# Right Sidebar with Git Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a VS Code-style right sidebar with a tabbed system, Git as the first tab (with worktree overview), detachable to an Electron window.

**Architecture:** New `RightSidebar` component mirrors the left sidebar's collapse/expand/resize mechanics. Git tab adapts existing `GitPanel` logic for sidebar context. A new `git:worktreeList` IPC channel adds worktree listing. The toolbar's Git button toggles the right sidebar instead of creating a canvas node.

**Tech Stack:** React 18, Zustand, Tailwind CSS, Electron IPC, simple-git, lucide-react

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/renderer/sidebar/RightSidebar.tsx` | Right sidebar container: collapse/expand, resize, tab icon strip, tab content rendering |
| `src/renderer/sidebar/GitSidebarTab.tsx` | Git tab content: branch, staged/unstaged files, diff, commit (adapted from GitPanel) |
| `src/renderer/sidebar/WorktreeList.tsx` | Collapsible worktree list sub-component |
| `src/renderer/stores/uiStore.ts` | Add right sidebar state (visible, activeTab, detached) |
| `src/shared/ipc-channels.ts` | Add `GIT_WORKTREE_LIST` channel constant |
| `src/shared/electron-api.d.ts` | Add `gitWorktreeList` type declaration |
| `src/preload/index.ts` | Expose `gitWorktreeList` bridge |
| `src/main/ipc/git.ts` | Implement `git:worktreeList` handler |
| `src/renderer/canvas/CanvasToolbar.tsx` | Git button toggles right sidebar |
| `src/renderer/App.tsx` | Wire RightSidebar into layout |

---

### Task 1: Add right sidebar state to uiStore

**Files:**
- Modify: `src/renderer/stores/uiStore.ts`

- [ ] **Step 1: Add right sidebar state and actions to the store interface**

Add these fields to `UIStoreState`:

```typescript
rightSidebarVisible: boolean
rightSidebarActiveTab: string
rightSidebarDetached: boolean
```

Add these to `UIStoreActions`:

```typescript
toggleRightSidebar: () => void
setRightSidebarTab: (tab: string) => void
setRightSidebarVisible: (visible: boolean) => void
setRightSidebarDetached: (detached: boolean) => void
```

- [ ] **Step 2: Implement the state and actions in the store**

Add initial state values:

```typescript
rightSidebarVisible: false,
rightSidebarActiveTab: 'git',
rightSidebarDetached: false,
```

Add action implementations:

```typescript
toggleRightSidebar() {
  set((state) => ({ rightSidebarVisible: !state.rightSidebarVisible }))
},
setRightSidebarTab(tab) {
  set({ rightSidebarActiveTab: tab, rightSidebarVisible: true })
},
setRightSidebarVisible(visible) {
  set({ rightSidebarVisible: visible })
},
setRightSidebarDetached(detached) {
  set({ rightSidebarDetached: detached })
},
```

- [ ] **Step 3: Verify the app still compiles**

Run: `npm run dev` — confirm no TypeScript errors in the console.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/stores/uiStore.ts
git commit -m "feat: add right sidebar state to uiStore"
```

---

### Task 2: Add git:worktreeList IPC channel (backend)

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Modify: `src/main/ipc/git.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/electron-api.d.ts`

- [ ] **Step 1: Add the IPC channel constant**

In `src/shared/ipc-channels.ts`, after the `GIT_COMMIT` line:

```typescript
export const GIT_WORKTREE_LIST = 'git:worktreeList'
```

- [ ] **Step 2: Add the main process handler**

In `src/main/ipc/git.ts`, add the import of the new channel:

```typescript
import {
  GIT_IS_REPO,
  GIT_LS_FILES,
  GIT_STATUS,
  GIT_DIFF,
  GIT_STAGE,
  GIT_UNSTAGE,
  GIT_COMMIT,
  GIT_WORKTREE_LIST,
} from '../../shared/ipc-channels'
```

Add the handler inside `registerHandlers()`, after the `GIT_COMMIT` handler:

```typescript
ipcMain.handle(GIT_WORKTREE_LIST, async (_event, cwd: string) => {
  try {
    const git = simpleGit(cwd)
    const raw = await git.raw(['worktree', 'list', '--porcelain'])
    const worktrees: Array<{
      path: string
      branch: string
      isBare: boolean
      isCurrent: boolean
    }> = []

    // Parse porcelain output — blocks separated by blank lines
    const blocks = raw.trim().split('\n\n')
    for (const block of blocks) {
      const lines = block.split('\n')
      let wtPath = ''
      let branch = ''
      let isBare = false
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length)
        } else if (line.startsWith('branch ')) {
          // branch refs/heads/main -> main
          branch = line.slice('branch '.length).replace('refs/heads/', '')
        } else if (line === 'bare') {
          isBare = true
        } else if (line.startsWith('HEAD ') && !branch) {
          // detached HEAD — show abbreviated SHA
          branch = line.slice('HEAD '.length).substring(0, 8)
        }
      }
      if (wtPath) {
        worktrees.push({
          path: wtPath,
          branch: branch || '(unknown)',
          isBare,
          isCurrent: path.resolve(wtPath) === path.resolve(cwd),
        })
      }
    }
    return worktrees
  } catch {
    return []
  }
})
```

- [ ] **Step 3: Add the preload bridge**

In `src/preload/index.ts`, add `GIT_WORKTREE_LIST` to the import list from `'../shared/ipc-channels'`.

Then add the bridge method in the git section, after `gitCommit`:

```typescript
gitWorktreeList(cwd: string): Promise<Array<{ path: string; branch: string; isBare: boolean; isCurrent: boolean }>> {
  return ipcRenderer.invoke(GIT_WORKTREE_LIST, cwd)
},
```

- [ ] **Step 4: Add the type declaration**

In `src/shared/electron-api.d.ts`, after the `gitCommit` method declaration:

```typescript
/** List git worktrees for a repository. */
gitWorktreeList(cwd: string): Promise<Array<{
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
}>>
```

- [ ] **Step 5: Verify the app compiles**

Run: `npm run dev` — confirm no errors.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/ipc/git.ts src/preload/index.ts src/shared/electron-api.d.ts
git commit -m "feat: add git:worktreeList IPC channel"
```

---

### Task 3: Create WorktreeList component

**Files:**
- Create: `src/renderer/sidebar/WorktreeList.tsx`

- [ ] **Step 1: Create the WorktreeList component**

```tsx
// =============================================================================
// WorktreeList — Collapsible list of local git worktrees.
// =============================================================================

import React, { useState, useEffect, useCallback } from 'react'
import { ChevronRight, ChevronDown, GitBranch } from 'lucide-react'

interface GitWorktree {
  path: string
  branch: string
  isBare: boolean
  isCurrent: boolean
}

interface WorktreeListProps {
  rootPath: string
  /** Called on mount and when parent triggers a refresh. */
  refreshKey?: number
}

export const WorktreeList: React.FC<WorktreeListProps> = ({ rootPath, refreshKey }) => {
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([])
  const [collapsed, setCollapsed] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const result = await window.electronAPI.gitWorktreeList(rootPath)
      setWorktrees(result)
      // Auto-expand if there are multiple worktrees
      if (result.length > 1) setCollapsed(false)
    } catch {
      setWorktrees([])
    }
  }, [rootPath])

  useEffect(() => { refresh() }, [refresh, refreshKey])

  if (worktrees.length <= 1) return null

  const basename = (p: string) => p.split('/').pop() || p

  return (
    <div>
      <button
        className="flex items-center gap-1 w-full px-3 py-1 text-xs text-white/40 uppercase hover:text-white/60 transition-colors"
        onClick={() => setCollapsed(!collapsed)}
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        Worktrees ({worktrees.length})
      </button>
      {!collapsed && worktrees.map((wt) => (
        <div
          key={wt.path}
          className="flex items-center gap-2 px-3 py-1 text-xs"
        >
          <GitBranch size={12} className={wt.isCurrent ? 'text-green-400' : 'text-white/30'} />
          <span className={wt.isCurrent ? 'text-white/80 font-medium' : 'text-white/50'}>
            {wt.branch}
          </span>
          <span className="text-white/20 truncate ml-auto">{basename(wt.path)}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/sidebar/WorktreeList.tsx
git commit -m "feat: add WorktreeList component"
```

---

### Task 4: Create GitSidebarTab component

**Files:**
- Create: `src/renderer/sidebar/GitSidebarTab.tsx`

- [ ] **Step 1: Create the GitSidebarTab component**

This adapts the logic from `src/renderer/panels/GitPanel.tsx` but without `panelId`/`nodeId` props — it reads `workspaceId` from the app store directly.

```tsx
// =============================================================================
// GitSidebarTab — Git status, diff, staging, and commit UI for the right sidebar.
// Adapted from panels/GitPanel.tsx for sidebar context.
// =============================================================================

import React, { useState, useCallback, useEffect } from 'react'
import { useAppStore } from '../stores/appStore'
import { WorktreeList } from './WorktreeList'

interface GitFile {
  path: string
  index: string
  working_dir: string
}

export const GitSidebarTab: React.FC = () => {
  const workspaceId = useAppStore((s) => s.selectedWorkspaceId)
  const rootPath = useAppStore((s) => s.workspaces.find((w) => w.id === s.selectedWorkspaceId)?.rootPath)
  const [files, setFiles] = useState<GitFile[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const [commitMsg, setCommitMsg] = useState('')
  const [diff, setDiff] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = useCallback(async () => {
    if (!rootPath) return
    setIsLoading(true)
    try {
      const status = await window.electronAPI.gitStatus(rootPath)
      setFiles(status.files)
      setBranch(status.current)
    } catch {
      /* not a git repo */
    }
    setIsLoading(false)
    setRefreshKey((k) => k + 1)
  }, [rootPath])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!rootPath) return
      setSelectedFile(filePath)
      try {
        const d = await window.electronAPI.gitDiff(rootPath, filePath)
        setDiff(d)
      } catch {
        setDiff('')
      }
    },
    [rootPath],
  )

  const handleStage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return
      await window.electronAPI.gitStage(rootPath, filePath)
      refresh()
    },
    [rootPath, refresh],
  )

  const handleUnstage = useCallback(
    async (filePath: string) => {
      if (!rootPath) return
      await window.electronAPI.gitUnstage(rootPath, filePath)
      refresh()
    },
    [rootPath, refresh],
  )

  const handleCommit = useCallback(async () => {
    if (!rootPath || !commitMsg.trim()) return
    await window.electronAPI.gitCommit(rootPath, commitMsg.trim())
    setCommitMsg('')
    setDiff('')
    setSelectedFile(null)
    refresh()
  }, [rootPath, commitMsg, refresh])

  if (!rootPath) {
    return (
      <div className="flex items-center justify-center h-full text-white/30 text-sm">
        Set a workspace root to use Git
      </div>
    )
  }

  const staged = files.filter((f) => f.index !== ' ' && f.index !== '?')
  const unstaged = files.filter((f) => f.working_dir !== ' ')

  return (
    <div className="flex flex-col h-full text-sm">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.05]">
        <span className="text-white/60">{branch ? `Branch: ${branch}` : 'Git'}</span>
        <button onClick={refresh} className="text-white/40 hover:text-white/80 text-xs">
          ↻ Refresh
        </button>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        {/* Worktrees */}
        <WorktreeList rootPath={rootPath} refreshKey={refreshKey} />

        {/* Staged */}
        {staged.length > 0 && (
          <div>
            <div className="px-3 py-1 text-xs text-green-400/60 uppercase">Staged</div>
            {staged.map((f) => (
              <div
                key={`s-${f.path}`}
                className={`flex items-center px-3 py-1 hover:bg-white/[0.03] cursor-pointer ${selectedFile === f.path ? 'bg-white/[0.05]' : ''}`}
                onClick={() => handleSelectFile(f.path)}
              >
                <span className="text-green-400 w-4 text-center mr-2 font-mono">{f.index}</span>
                <span className="text-white/70 flex-1 truncate">{f.path}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleUnstage(f.path)
                  }}
                  className="text-white/30 hover:text-white/60 text-xs ml-2 flex-shrink-0"
                >
                  Unstage
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Unstaged */}
        {unstaged.length > 0 && (
          <div>
            <div className="px-3 py-1 text-xs text-orange-400/60 uppercase">Changes</div>
            {unstaged.map((f) => (
              <div
                key={`u-${f.path}`}
                className={`flex items-center px-3 py-1 hover:bg-white/[0.03] cursor-pointer ${selectedFile === f.path ? 'bg-white/[0.05]' : ''}`}
                onClick={() => handleSelectFile(f.path)}
              >
                <span className="text-orange-400 w-4 text-center mr-2 font-mono">{f.working_dir}</span>
                <span className="text-white/70 flex-1 truncate">{f.path}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleStage(f.path)
                  }}
                  className="text-white/30 hover:text-white/60 text-xs ml-2 flex-shrink-0"
                >
                  Stage
                </button>
              </div>
            ))}
          </div>
        )}

        {files.length === 0 && !isLoading && (
          <div className="px-3 py-4 text-white/30 text-center">Clean working tree</div>
        )}
        {isLoading && (
          <div className="px-3 py-4 text-white/20 text-center text-xs">Loading...</div>
        )}
      </div>

      {/* Diff preview */}
      {diff && (
        <div className="border-t border-white/[0.05] max-h-[200px] overflow-y-auto">
          <pre className="text-xs font-mono p-2 text-white/60 whitespace-pre-wrap">
            {diff.slice(0, 3000)}
          </pre>
        </div>
      )}

      {/* Commit */}
      <div className="p-2 border-t border-white/[0.05]">
        <input
          type="text"
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCommit()
          }}
          className="w-full bg-[#28282E] text-white text-xs px-2 py-1.5 rounded border border-white/[0.1] outline-none focus:border-blue-500/50 mb-1.5"
          placeholder="Commit message..."
        />
        <button
          onClick={handleCommit}
          disabled={!commitMsg.trim() || staged.length === 0}
          className="w-full py-1.5 bg-green-600/30 hover:bg-green-600/40 text-white/80 text-xs rounded disabled:opacity-30 transition-colors"
        >
          Commit ({staged.length} staged)
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/sidebar/GitSidebarTab.tsx
git commit -m "feat: add GitSidebarTab component for right sidebar"
```

---

### Task 5: Create RightSidebar component

**Files:**
- Create: `src/renderer/sidebar/RightSidebar.tsx`

- [ ] **Step 1: Create the RightSidebar component**

```tsx
// =============================================================================
// RightSidebar — Collapsible, resizable right sidebar with tabbed content.
// Mirrors the left Sidebar's collapse/expand/resize mechanics.
// =============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '../stores/uiStore'
import { GitBranch, ExternalLink } from 'lucide-react'
import { GitSidebarTab } from './GitSidebarTab'

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DEFAULT_WIDTH = 280
const MIN_WIDTH = 140
const MAX_WIDTH = 500
const COLLAPSED_WIDTH = 40

// -----------------------------------------------------------------------------
// Tab definitions
// -----------------------------------------------------------------------------

interface TabDef {
  id: string
  icon: React.ReactNode
  label: string
  component: React.FC
}

const TABS: TabDef[] = [
  {
    id: 'git',
    icon: <GitBranch size={16} />,
    label: 'Git',
    component: GitSidebarTab,
  },
]

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const RightSidebar: React.FC = () => {
  const isVisible = useUIStore((s) => s.rightSidebarVisible)
  const activeTab = useUIStore((s) => s.rightSidebarActiveTab)
  const isDetached = useUIStore((s) => s.rightSidebarDetached)
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar)
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab)
  const setRightSidebarDetached = useUIStore((s) => s.setRightSidebarDetached)
  const setRightSidebarVisible = useUIStore((s) => s.setRightSidebarVisible)

  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [isResizing, setIsResizing] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // ---------------------------------------------------------------------------
  // Left-edge resize (drag handle on the left side)
  // ---------------------------------------------------------------------------

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsResizing(true)
      startXRef.current = e.clientX
      startWidthRef.current = width
    },
    [width],
  )

  useEffect(() => {
    if (!isResizing) return

    let rafPending = false
    const handleMouseMove = (e: MouseEvent) => {
      if (rafPending) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        // Dragging left = larger width (opposite of left sidebar)
        const delta = startXRef.current - e.clientX
        const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta))
        setWidth(newWidth)
      })
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing])

  // ---------------------------------------------------------------------------
  // Tab click
  // ---------------------------------------------------------------------------

  const handleTabClick = useCallback(
    (tabId: string) => {
      if (isVisible && activeTab === tabId) {
        toggleRightSidebar()
      } else {
        setRightSidebarTab(tabId)
      }
    },
    [isVisible, activeTab, toggleRightSidebar, setRightSidebarTab],
  )

  // ---------------------------------------------------------------------------
  // Detach / Reattach
  // ---------------------------------------------------------------------------

  const handleDetach = useCallback(async () => {
    await window.electronAPI.detachPanel({
      title: TABS.find((t) => t.id === activeTab)?.label || 'Sidebar',
      width,
      height: window.innerHeight,
    })
    setRightSidebarDetached(true)
    setRightSidebarVisible(false)
  }, [activeTab, width, setRightSidebarDetached, setRightSidebarVisible])

  const handleReattach = useCallback(() => {
    setRightSidebarDetached(false)
    setRightSidebarVisible(true)
  }, [setRightSidebarDetached, setRightSidebarVisible])

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const ActiveComponent = TABS.find((t) => t.id === activeTab)?.component

  // --- Collapsed icon strip ---
  return (
    <div className="flex-shrink-0 flex h-full">
      {/* Expanded content area */}
      {isVisible && !isDetached && (
        <div
          className="relative flex flex-col h-full bg-canvas-bg border-l border-white/10 overflow-hidden"
          style={{ width: `${width}px` }}
        >
          {/* macOS titlebar drag region */}
          <div className="h-7 flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

          {/* Tab header with detach button */}
          <div className="flex items-center justify-between px-2 py-1 border-b border-white/[0.05]">
            <span className="text-xs text-white/50 uppercase">
              {TABS.find((t) => t.id === activeTab)?.label}
            </span>
            <button
              onClick={handleDetach}
              className="text-white/30 hover:text-white/60 p-1 rounded hover:bg-white/10 transition-colors"
              title="Detach to window"
            >
              <ExternalLink size={12} />
            </button>
          </div>

          {/* Tab content */}
          <div className="flex-1 min-h-0">
            {ActiveComponent && <ActiveComponent />}
          </div>

          {/* Left edge resize handle */}
          <div
            className={`absolute top-0 left-0 w-[6px] h-full cursor-col-resize z-10 ${
              isResizing ? 'bg-blue-500/30' : ''
            }`}
            onMouseDown={handleResizeMouseDown}
          />
        </div>
      )}

      {/* Detached placeholder */}
      {isDetached && (
        <div className="relative flex flex-col items-center justify-center h-full bg-canvas-bg border-l border-white/10 px-4" style={{ width: `${COLLAPSED_WIDTH + 80}px` }}>
          <div className="h-7 flex-shrink-0 w-full" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
          <span className="text-xs text-white/30 mb-2">Detached</span>
          <button
            onClick={handleReattach}
            className="text-xs text-white/50 hover:text-white/80 px-2 py-1 rounded bg-white/5 hover:bg-white/10 transition-colors"
          >
            Reattach
          </button>
        </div>
      )}

      {/* Icon strip (always visible) */}
      <div
        className="flex-shrink-0 flex flex-col items-center h-full bg-canvas-bg border-l border-white/10 select-none"
        style={{ width: `${COLLAPSED_WIDTH}px` }}
      >
        {/* macOS titlebar drag region */}
        <div className="h-7 w-full flex-shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />

        <div className="flex flex-col items-center gap-1 py-2">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`relative p-1.5 rounded transition-colors ${
                isVisible && activeTab === tab.id
                  ? 'text-white/80 bg-white/10'
                  : 'text-white/40 hover:text-white/70 hover:bg-white/10'
              }`}
              onClick={() => handleTabClick(tab.id)}
              title={tab.label}
            >
              {/* Active indicator */}
              {isVisible && activeTab === tab.id && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-4 bg-white/60 rounded-r" />
              )}
              {tab.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/sidebar/RightSidebar.tsx
git commit -m "feat: add RightSidebar component with tab system"
```

---

### Task 6: Wire RightSidebar into App layout and update toolbar

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/canvas/CanvasToolbar.tsx`

- [ ] **Step 1: Add RightSidebar to App.tsx layout**

Add the import near the other sidebar imports (around line 18-19):

```typescript
import { RightSidebar } from './sidebar/RightSidebar'
```

In the return JSX, add `<RightSidebar />` after the canvas workspace `</div>` and before the modal overlays section. The layout becomes:

```tsx
<div className="h-screen w-screen flex bg-canvas-bg" onDragOver={handleFileDragOver} onDrop={handleFileDrop}>
  {/* Sidebar */}
  <Sidebar isVisible={sidebarVisible} />

  {/* File Explorer — separate collapsible sidebar */}
  <FileExplorerSidebar />

  {/* Canvas workspace area */}
  <div className="flex-1 relative overflow-hidden">
    {/* ... existing canvas content ... */}
  </div>

  {/* Right sidebar */}
  <RightSidebar />

  {/* Modal overlays */}
  {/* ... existing modals ... */}
</div>
```

- [ ] **Step 2: Change the toolbar Git button callback**

In `App.tsx`, replace the `onNewGit` callback (around line 126-128):

```typescript
const onNewGit = useCallback(() => {
  useUIStore.getState().setRightSidebarTab('git')
}, [])
```

This opens the right sidebar to the Git tab instead of creating a canvas node. The canvas-based git panel remains available via right-click context menu and command palette.

- [ ] **Step 3: Update CanvasToolbar props — remove onNewGit, add onToggleGit**

In `src/renderer/canvas/CanvasToolbar.tsx`, the `onNewGit` prop already works — no interface change needed since the callback behavior changed at the App level. The prop name `onNewGit` is slightly misleading now but still functional.

Optionally rename the prop for clarity, but since the toolbar doesn't care what the callback does internally, this is fine as-is.

- [ ] **Step 4: Verify the app compiles and the sidebar shows**

Run: `npm run dev` — click the Git button in the toolbar. The right sidebar should expand showing the Git tab. Click the Git icon in the icon strip to collapse it.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx src/renderer/canvas/CanvasToolbar.tsx
git commit -m "feat: wire RightSidebar into app layout, toolbar toggles git sidebar"
```

---

### Task 7: Verify and polish

**Files:**
- Various (minor tweaks)

- [ ] **Step 1: Manual smoke test**

1. Launch the app with `npm run dev`
2. Click Git button in toolbar — right sidebar should expand with Git tab
3. Click Git icon in the icon strip — sidebar should collapse
4. Click Git icon again — sidebar should re-expand
5. Resize sidebar from its left edge — should respect 140-500px bounds
6. If workspace has a git repo, verify: branch name, file list, stage/unstage, diff preview, commit
7. If multiple worktrees exist, verify the worktree section appears and lists them
8. Click the detach button (ExternalLink icon) — sidebar should show "Detached" placeholder
9. Click "Reattach" — sidebar should restore
10. Right-click canvas → Git should still create a floating canvas node (unchanged)

- [ ] **Step 2: Fix any issues found during smoke test**

Address any visual or functional issues.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "fix: polish right sidebar styling and behavior"
```
