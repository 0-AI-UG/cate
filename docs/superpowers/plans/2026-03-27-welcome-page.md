# Welcome Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a welcome page overlay on the canvas when a workspace has no panels, with quick actions, recent projects, and keyboard shortcuts.

**Architecture:** New `WelcomePage` React component rendered as a centered overlay in `App.tsx` when `nodes` is empty. Recent projects tracked via electron-store with two new IPC channels. Startup creates an ephemeral workspace (no panels) that is excluded from session save until the user acts.

**Tech Stack:** React, Zustand, Tailwind CSS, lucide-react icons, electron-store, Electron IPC

---

### Task 1: Add Recent Projects IPC channels and main process handlers

**Files:**
- Modify: `src/shared/ipc-channels.ts:57` (add two new channel constants at end)
- Modify: `src/main/store.ts:96` (add recent projects handlers in `registerHandlers`)

- [ ] **Step 1: Add IPC channel constants**

In `src/shared/ipc-channels.ts`, add at the end before the closing line:

```typescript
// Recent Projects
export const RECENT_PROJECTS_GET = 'recent-projects:get'
export const RECENT_PROJECTS_ADD = 'recent-projects:add'
```

- [ ] **Step 2: Add main process IPC handlers**

In `src/main/store.ts`, import the new channels and add handlers inside `registerHandlers()`. The recent projects list is stored as a setting key `recentProjects` in the same electron-store instance:

```typescript
import {
  // ... existing imports ...
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
} from '../shared/ipc-channels'
```

Add these handlers inside `registerHandlers()`:

```typescript
  // Recent Projects
  ipcMain.handle(RECENT_PROJECTS_GET, async () => {
    const store = await getStore()
    return store.get('recentProjects', []) as string[]
  })

  ipcMain.handle(RECENT_PROJECTS_ADD, async (_event, projectPath: string) => {
    const store = await getStore()
    const existing: string[] = store.get('recentProjects', []) as string[]
    const filtered = existing.filter((p) => p !== projectPath)
    const updated = [projectPath, ...filtered].slice(0, 10)
    store.set('recentProjects', updated)
  })
```

- [ ] **Step 3: Commit**

```bash
git add src/shared/ipc-channels.ts src/main/store.ts
git commit -m "feat: add recent projects IPC channels and main handlers"
```

---

### Task 2: Expose Recent Projects API in preload and type declarations

**Files:**
- Modify: `src/preload/index.ts:38` (add imports) and `~line 290` (add methods)
- Modify: `src/shared/electron-api.d.ts:158` (add type declarations)

- [ ] **Step 1: Add preload imports**

In `src/preload/index.ts`, add to the import block:

```typescript
import {
  // ... existing ...
  RECENT_PROJECTS_GET,
  RECENT_PROJECTS_ADD,
} from '../shared/ipc-channels'
```

- [ ] **Step 2: Add preload methods**

Inside the `contextBridge.exposeInMainWorld('electronAPI', { ... })` object, add a new section before the closing `})`:

```typescript
  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  recentProjectsGet(): Promise<string[]> {
    return ipcRenderer.invoke(RECENT_PROJECTS_GET)
  },

  recentProjectsAdd(projectPath: string): Promise<void> {
    return ipcRenderer.invoke(RECENT_PROJECTS_ADD, projectPath)
  },
```

- [ ] **Step 3: Add type declarations**

In `src/shared/electron-api.d.ts`, add inside the `ElectronAPI` interface before the Menu section:

```typescript
  // ---------------------------------------------------------------------------
  // Recent Projects
  // ---------------------------------------------------------------------------

  /** Get list of recently opened project folders. */
  recentProjectsGet(): Promise<string[]>

  /** Add a project path to the recent projects list. */
  recentProjectsAdd(projectPath: string): Promise<void>
```

- [ ] **Step 4: Commit**

```bash
git add src/preload/index.ts src/shared/electron-api.d.ts
git commit -m "feat: expose recent projects API via preload bridge"
```

---

### Task 3: Track recent projects from appStore

**Files:**
- Modify: `src/renderer/stores/appStore.ts:326-337` (update `setWorkspaceRootPath`)

- [ ] **Step 1: Add recentProjectsAdd call in setWorkspaceRootPath**

In `src/renderer/stores/appStore.ts`, update the `setWorkspaceRootPath` method to also track the project:

```typescript
  setWorkspaceRootPath(wsId, rootPath) {
    const folderName = rootPath.split('/').filter(Boolean).pop() ?? rootPath
    set((state) => ({
      workspaces: state.workspaces.map((ws) => {
        if (ws.id !== wsId) return ws
        return {
          ...ws,
          rootPath,
          name: ws.name === 'Workspace' ? folderName : ws.name,
        }
      }),
    }))
    // Track in recent projects
    window.electronAPI.recentProjectsAdd(rootPath)
  },
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/stores/appStore.ts
git commit -m "feat: track recent projects when workspace root is set"
```

---

### Task 4: Create WelcomePage component

**Files:**
- Create: `src/renderer/ui/WelcomePage.tsx`

- [ ] **Step 1: Create the WelcomePage component**

Create `src/renderer/ui/WelcomePage.tsx`:

```tsx
import { useState, useEffect, useCallback } from 'react'
import { useAppStore } from '../stores/appStore'
import {
  Terminal,
  Globe,
  FileCode2,
  FolderOpen,
  Keyboard,
  Folder,
} from 'lucide-react'

// Abbreviate home directory in paths
function abbreviatePath(fullPath: string): string {
  const home = '/Users/'
  if (fullPath.startsWith(home)) {
    const rest = fullPath.slice(home.length)
    const slashIdx = rest.indexOf('/')
    return '~' + (slashIdx >= 0 ? rest.slice(slashIdx) : '')
  }
  return fullPath
}

export default function WelcomePage({ workspaceId }: { workspaceId: string }) {
  const [recentProjects, setRecentProjects] = useState<string[]>([])

  useEffect(() => {
    window.electronAPI.recentProjectsGet().then(setRecentProjects).catch(() => {})
  }, [])

  const openFolder = useCallback(async () => {
    const path = await window.electronAPI.openFolderDialog()
    if (path) {
      useAppStore.getState().setWorkspaceRootPath(workspaceId, path)
    }
  }, [workspaceId])

  const openRecentProject = useCallback(
    (path: string) => {
      useAppStore.getState().setWorkspaceRootPath(workspaceId, path)
    },
    [workspaceId],
  )

  const newTerminal = useCallback(() => {
    useAppStore.getState().createTerminal(workspaceId)
  }, [workspaceId])

  const newEditor = useCallback(() => {
    useAppStore.getState().createEditor(workspaceId)
  }, [workspaceId])

  const newBrowser = useCallback(() => {
    useAppStore.getState().createBrowser(workspaceId)
  }, [workspaceId])

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <div className="pointer-events-auto max-w-2xl w-full px-8">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-white/90 tracking-tight">
            CanvasIDE
          </h1>
          <p className="text-sm text-white/40 mt-1">
            Infinite canvas for coding
          </p>
        </div>

        {/* Two-column layout: Start + Recent */}
        <div className="flex gap-12">
          {/* Start actions */}
          <div className="flex-1">
            <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
              Start
            </h2>
            <div className="flex flex-col gap-1">
              <ActionItem
                icon={<FolderOpen size={16} />}
                label="Open Folder..."
                onClick={openFolder}
              />
              <ActionItem
                icon={<Terminal size={16} />}
                label="New Terminal"
                shortcut="⌘T"
                onClick={newTerminal}
              />
              <ActionItem
                icon={<FileCode2 size={16} />}
                label="New Editor"
                shortcut="⌘⇧E"
                onClick={newEditor}
              />
              <ActionItem
                icon={<Globe size={16} />}
                label="New Browser"
                shortcut="⌘⇧B"
                onClick={newBrowser}
              />
            </div>
          </div>

          {/* Recent Projects */}
          {recentProjects.length > 0 && (
            <div className="flex-1">
              <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
                Recent
              </h2>
              <div className="flex flex-col gap-0.5">
                {recentProjects.map((projectPath) => {
                  const name = projectPath.split('/').filter(Boolean).pop() ?? projectPath
                  const parent = abbreviatePath(
                    projectPath.split('/').slice(0, -1).join('/'),
                  )
                  return (
                    <button
                      key={projectPath}
                      className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/5 transition-colors group"
                      onClick={() => openRecentProject(projectPath)}
                    >
                      <Folder
                        size={14}
                        className="text-white/30 group-hover:text-white/60 flex-shrink-0"
                      />
                      <span className="text-sm text-blue-400 group-hover:text-blue-300 truncate">
                        {name}
                      </span>
                      <span className="text-xs text-white/25 truncate">
                        {parent}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* Keyboard shortcuts */}
        <div className="mt-10 pt-6 border-t border-white/5">
          <h2 className="text-xs font-semibold text-white/50 uppercase tracking-wider mb-3">
            Keyboard Shortcuts
          </h2>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            <ShortcutRow keys="⌘T" label="New Terminal" />
            <ShortcutRow keys="⌘⇧B" label="New Browser" />
            <ShortcutRow keys="⌘⇧E" label="New Editor" />
            <ShortcutRow keys="⌘K" label="Command Palette" />
            <ShortcutRow keys="⌘\" label="Toggle Sidebar" />
            <ShortcutRow keys="⌘0" label="Reset Zoom" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ActionItem({
  icon,
  label,
  shortcut,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-white/5 transition-colors group"
      onClick={onClick}
    >
      <span className="text-white/30 group-hover:text-white/60">{icon}</span>
      <span className="text-sm text-blue-400 group-hover:text-blue-300">
        {label}
      </span>
      {shortcut && (
        <span className="ml-auto text-xs text-white/20">{shortcut}</span>
      )}
    </button>
  )
}

function ShortcutRow({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50 font-mono w-10 text-right">
        {keys}
      </span>
      <span className="text-xs text-white/30">{label}</span>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/ui/WelcomePage.tsx
git commit -m "feat: create WelcomePage component with actions, recents, and shortcuts"
```

---

### Task 5: Integrate WelcomePage into App.tsx and make startup workspace ephemeral

**Files:**
- Modify: `src/renderer/App.tsx:25-26` (update imports)
- Modify: `src/renderer/App.tsx:79-85` (change fallback workspace creation)
- Modify: `src/renderer/App.tsx:198-217` (render WelcomePage when canvas empty)

- [ ] **Step 1: Update imports in App.tsx**

Replace the WelcomeBanner import:

```typescript
// Remove this line:
import { generateWelcomeBanner } from './ui/WelcomeBanner'
// Add this line:
import WelcomePage from './ui/WelcomePage'
```

- [ ] **Step 2: Change fallback workspace to be empty (no welcome terminal)**

In the init function (~line 79-85), replace:

```typescript
      if (useAppStore.getState().workspaces.length === 0) {
        const wsId = useAppStore.getState().addWorkspace()
        useAppStore.getState().selectWorkspace(wsId)
        useAppStore.getState().createTerminal(wsId, generateWelcomeBanner())
      }
```

With:

```typescript
      if (useAppStore.getState().workspaces.length === 0) {
        const wsId = useAppStore.getState().addWorkspace()
        useAppStore.getState().selectWorkspace(wsId)
      }
```

- [ ] **Step 3: Render WelcomePage when canvas is empty**

In the JSX, inside the canvas workspace area div (`<div className="flex-1 relative overflow-hidden">`), add the WelcomePage before the Canvas:

```tsx
      <div className="flex-1 relative overflow-hidden">
        {/* Welcome page overlay when no panels exist */}
        {Object.keys(nodes).length === 0 && (
          <WelcomePage workspaceId={selectedWorkspaceId} />
        )}

        <Canvas onCreateAtPoint={onCreateAtPoint}>
```

- [ ] **Step 4: Verify the app compiles**

Run: `npm run dev`
Expected: App starts, shows WelcomePage centered on the empty canvas instead of a welcome terminal.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat: show WelcomePage on empty canvas, remove welcome terminal"
```

---

### Task 6: Skip ephemeral workspaces in session save

**Files:**
- Modify: `src/renderer/lib/session.ts:31-75` (filter ephemeral workspaces in saveSession)

- [ ] **Step 1: Filter ephemeral workspaces before saving**

In `saveSession()`, after the line `appState.syncCanvasToWorkspace(appState.selectedWorkspaceId)` and before the `for` loop, add a filter. Replace the existing for loop's source:

Change:

```typescript
  for (const workspace of appState.workspaces) {
```

To:

```typescript
  // Skip ephemeral workspaces (no panels and no rootPath)
  const persistableWorkspaces = appState.workspaces.filter(
    (ws) => Object.keys(ws.panels).length > 0 || ws.rootPath,
  )

  for (const workspace of persistableWorkspaces) {
```

Also update the `selectedIndex` calculation to reference `persistableWorkspaces`:

Change:

```typescript
  const selectedIndex = appState.workspaces.findIndex((w) => w.id === appState.selectedWorkspaceId)
```

To:

```typescript
  const selectedIndex = persistableWorkspaces.findIndex((w) => w.id === appState.selectedWorkspaceId)
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/lib/session.ts
git commit -m "feat: skip ephemeral workspaces in session save"
```

---

### Task 7: Manual smoke test

- [ ] **Step 1: Fresh start test**

Run: `npm run dev`
Clear the session file: delete `~/Library/Application Support/canvaside/Sessions/session.json` (or equivalent) and restart.
Expected: App shows the WelcomePage with Start actions and Keyboard Shortcuts. No Recent section if no projects have been opened.

- [ ] **Step 2: Open folder test**

Click "Open Folder..." on the welcome page. Select a folder.
Expected: Workspace root is set, welcome page disappears (a file explorer or similar becomes active). Folder appears in Recent on next empty workspace.

- [ ] **Step 3: Recent projects test**

Create a new workspace (+ button in sidebar). The new workspace shows the welcome page with the previously opened folder in the Recent section. Click it.
Expected: Workspace root is set to that folder.

- [ ] **Step 4: Ephemeral workspace test**

Restart the app with an empty workspace (no actions taken).
Expected: The empty workspace is NOT saved to the session file. On restart, a fresh welcome page appears.

- [ ] **Step 5: Panel creation test**

From the welcome page, click "New Terminal".
Expected: Welcome page disappears, terminal panel appears on canvas. Workspace is now persistable.
