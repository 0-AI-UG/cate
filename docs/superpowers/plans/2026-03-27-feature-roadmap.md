# CanvasIDE Feature Roadmap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement 27 features from the CanvasIDE feature roadmap spec (`docs/superpowers/specs/2026-03-27-feature-roadmap.md`) in 7 phases.

**Architecture:** Electron + React + TypeScript + Zustand + Tailwind. Renderer has 6 Zustand stores. Main process handles IPC. No tests exist. All new state fields must be persisted in session snapshots.

**Tech Stack:** Electron, React 18, Zustand, Tailwind CSS, xterm.js, Monaco Editor, lucide-react

**Note:** Each phase is independently shippable. Features within a phase have no cross-dependencies unless noted. Phases should be executed sequentially (Phase 1 → 2 → ...) but features within a phase can be parallelized.

---

## Phase 1: Quick Wins

### Task 1: Zoom-to-Fit

**Files:**
- Modify: `src/shared/types.ts` — add `'zoomToFit'` to ShortcutAction
- Modify: `src/renderer/stores/canvasStore.ts` — add `zoomToFit()` action
- Modify: `src/renderer/hooks/useShortcuts.ts` — add case for `'zoomToFit'`
- Modify: `src/renderer/ui/CommandPalette.tsx` — add "Zoom to Fit" command

- [ ] **Step 1: Add ShortcutAction to types.ts**

In `src/shared/types.ts`, add `'zoomToFit'` to the `ShortcutAction` union (after `'saveFile'`), to `SHORTCUT_ACTIONS` array, to `SHORTCUT_DISPLAY_NAMES` (`'Zoom to Fit'`), and to `DEFAULT_SHORTCUTS`:
```ts
zoomToFit: storedShortcut('1', { command: true }),
```

- [ ] **Step 2: Add zoomToFit action to canvasStore**

In `src/renderer/stores/canvasStore.ts`, add to the interface and implementation:
```ts
zoomToFit() {
  const state = get()
  const nodeList = Object.values(state.nodes)
  if (nodeList.length === 0) return
  const cs = state.containerSize
  if (cs.width === 0 || cs.height === 0) return

  const minX = Math.min(...nodeList.map(n => n.origin.x))
  const minY = Math.min(...nodeList.map(n => n.origin.y))
  const maxX = Math.max(...nodeList.map(n => n.origin.x + n.size.width))
  const maxY = Math.max(...nodeList.map(n => n.origin.y + n.size.height))

  const padding = 60
  const contentW = maxX - minX + padding * 2
  const contentH = maxY - minY + padding * 2
  const zoom = Math.min(Math.max(Math.min(cs.width / contentW, cs.height / contentH), ZOOM_MIN), ZOOM_MAX)

  set({
    zoomLevel: zoom,
    viewportOffset: {
      x: (cs.width - contentW * zoom) / 2 - (minX - padding) * zoom,
      y: (cs.height - contentH * zoom) / 2 - (minY - padding) * zoom,
    },
  })
},
```

- [ ] **Step 3: Wire shortcut in useShortcuts.ts**

Add case in the switch statement in `src/renderer/hooks/useShortcuts.ts`:
```ts
case 'zoomToFit':
  canvasStore().zoomToFit()
  break
```

- [ ] **Step 4: Add command to CommandPalette**

In `src/renderer/ui/CommandPalette.tsx`, add to the `allCommands` array:
```ts
{ label: 'Zoom to Fit', shortcut: '⌘1', action: () => useCanvasStore.getState().zoomToFit() },
```

- [ ] **Step 5: Verify and commit**

Run `npx tsc --noEmit`. Test: open app, create 2+ panels, zoom/pan away, press Cmd+1 — all panels should be visible with padding.
```bash
git add src/shared/types.ts src/renderer/stores/canvasStore.ts src/renderer/hooks/useShortcuts.ts src/renderer/ui/CommandPalette.tsx
git commit -m "feat: add zoom-to-fit shortcut (Cmd+1)"
```

---

### Task 2: Auto-Focus & Center New Panels

**Files:**
- Modify: `src/renderer/stores/canvasStore.ts` — add `focusAndCenter(nodeId)` helper action
- Modify: `src/renderer/stores/appStore.ts` — call focusAndCenter after addNode in createTerminal/Editor/Browser

- [ ] **Step 1: Add focusAndCenter action to canvasStore**

```ts
focusAndCenter(nodeId: CanvasNodeId) {
  const state = get()
  const node = state.nodes[nodeId]
  if (!node) return
  // Focus (bumps z-order)
  const updated = { ...node, zOrder: state.nextZOrder }
  set({
    nodes: { ...state.nodes, [nodeId]: updated },
    nextZOrder: state.nextZOrder + 1,
    focusedNodeId: nodeId,
  })
  // Center viewport on the node
  const cs = state.containerSize
  const zoom = state.zoomLevel
  if (cs.width > 0 && cs.height > 0) {
    set({
      viewportOffset: {
        x: cs.width / 2 - (node.origin.x + node.size.width / 2) * zoom,
        y: cs.height / 2 - (node.origin.y + node.size.height / 2) * zoom,
      },
    })
  }
},
```

- [ ] **Step 2: Call focusAndCenter in appStore panel creation methods**

In `src/renderer/stores/appStore.ts`, after each `addNode` call in `createTerminal`, `createBrowser`, and `createEditor`, add:
```ts
const nodeId = useCanvasStore.getState().addNode(panelId, 'terminal', position)
useCanvasStore.getState().focusAndCenter(nodeId)
```
Apply the same pattern to all three methods (replacing current `addNode` calls that discard the return value).

- [ ] **Step 3: Verify and commit**

Run `npx tsc --noEmit`. Test: create a new terminal — canvas should pan to center on it.
```bash
git add src/renderer/stores/canvasStore.ts src/renderer/stores/appStore.ts
git commit -m "feat: auto-focus and center viewport on new panels"
```

---

### Task 3: Auto-Open Terminal at Project Root

**Files:**
- Verify: `src/renderer/panels/TerminalPanel.tsx` — already passes rootPath as cwd

- [ ] **Step 1: Verify existing behavior**

Read `src/renderer/panels/TerminalPanel.tsx` line 34 and 48. The `rootPath` is already read from appStore and passed as `cwd` to `terminalRegistry.getOrCreate`. Verify this works by setting a workspace root and creating a new terminal — it should start in that directory.

- [ ] **Step 2: Mark as done if working, or fix if not**

If terminals already open at workspace root: commit a note or skip. If not: ensure `cwd: rootPath || undefined` is passed correctly.

---

### Task 4: Middle-Click Pan

**Files:**
- Modify: `src/renderer/hooks/useCanvasInteraction.ts` — handle button 1 (middle) for panning

- [ ] **Step 1: Track which button started panning**

Add a ref to track the pan button:
```ts
const panButton = useRef<number | null>(null)
```

- [ ] **Step 2: Handle middle-click in handleMouseDown**

Change the right-click condition to also handle middle-click:
```ts
if (e.button === 2 || e.button === 1) {
  isPanning.current = true
  panButton.current = e.button
  lastPanPos.current = { x: e.clientX, y: e.clientY }
  if (e.button === 2) {
    rightClickStart.current = { x: e.clientX, y: e.clientY }
    rightClickDidDrag.current = false
  }
  e.preventDefault()
}
```

- [ ] **Step 3: Handle middle-click in handleMouseUp**

Only show context menu for right-click (button 2), but stop panning for both:
```ts
const handleMouseUp = useCallback(
  (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button === 2) {
      // existing context menu logic...
    }
    if (e.button === panButton.current) {
      isPanning.current = false
      panButton.current = null
      lastPanPos.current = null
      latestPanPos.current = null
      rightClickStart.current = null
      if (panRafId.current !== null) {
        cancelAnimationFrame(panRafId.current)
        panRafId.current = null
      }
    }
  },
  [canvasRef],
)
```

- [ ] **Step 4: Verify and commit**

Run `npx tsc --noEmit`. Test: middle-click drag on canvas should pan.
```bash
git add src/renderer/hooks/useCanvasInteraction.ts
git commit -m "feat: add middle-click pan support"
```

---

### Task 5: Open Folder via Drag-and-Drop from Finder

**Files:**
- Modify: `src/renderer/App.tsx` — add onDragOver/onDrop on root container
- Modify: `src/shared/ipc-channels.ts` — add `FS_STAT` channel
- Modify: `src/main/ipc/filesystem.ts` — add stat handler
- Modify: `src/preload/index.ts` — expose `fsStat`
- Modify: `src/shared/electron-api.d.ts` — add `fsStat` type

- [ ] **Step 1: Add fsStat IPC for checking if path is a directory**

In `src/shared/ipc-channels.ts`:
```ts
export const FS_STAT = 'fs:stat'
```

In `src/main/ipc/filesystem.ts`, add handler:
```ts
ipcMain.handle(FS_STAT, async (_event, filePath: string) => {
  const stat = await fs.promises.stat(filePath)
  return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
})
```

In `src/preload/index.ts`, expose:
```ts
fsStat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }> {
  return ipcRenderer.invoke(FS_STAT, filePath)
}
```

In `src/shared/electron-api.d.ts`, add to interface:
```ts
fsStat(filePath: string): Promise<{ isDirectory: boolean; isFile: boolean }>
```

- [ ] **Step 2: Add drag-and-drop handlers to App.tsx**

Add to the outermost `<div>` in App.tsx:
```tsx
const handleFileDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}, [])

const handleFileDrop = useCallback(async (e: React.DragEvent) => {
  e.preventDefault()
  const files = Array.from(e.dataTransfer.files)
  for (const file of files) {
    const path = (file as any).path as string | undefined
    if (!path) continue
    try {
      const stat = await window.electronAPI.fsStat(path)
      if (stat.isDirectory) {
        useAppStore.getState().setWorkspaceRootPath(selectedWorkspaceId, path)
        break
      }
    } catch { /* ignore */ }
  }
}, [selectedWorkspaceId])
```

Add `onDragOver={handleFileDragOver} onDrop={handleFileDrop}` to the root div.

- [ ] **Step 3: Verify and commit**

Run `npx tsc --noEmit`. Test: drag a folder from Finder onto the app window — workspace root should update.
```bash
git add src/shared/ipc-channels.ts src/main/ipc/filesystem.ts src/preload/index.ts src/shared/electron-api.d.ts src/renderer/App.tsx
git commit -m "feat: open folder via drag-and-drop from Finder"
```

---

### Task 6: Copy Terminal CWD to Clipboard

**Files:**
- Modify: `src/renderer/sidebar/WorkspaceTab.tsx` — add "Copy Working Directory" to context menu

- [ ] **Step 1: Add context menu item**

In `WorkspaceTab.tsx`, find the context menu items array. Add an item:
```ts
{
  label: 'Copy Working Directory',
  onClick: async () => {
    const statusState = useStatusStore.getState()
    const wsStatus = statusState.workspaces[workspace.id]
    if (wsStatus) {
      // Get first terminal's CWD
      const cwds = Object.values(wsStatus.terminalCwd)
      const cwd = cwds[0] || workspace.rootPath
      if (cwd) {
        await navigator.clipboard.writeText(cwd)
      }
    }
  },
},
```

- [ ] **Step 2: Verify and commit**

```bash
git add src/renderer/sidebar/WorkspaceTab.tsx
git commit -m "feat: copy terminal CWD to clipboard from workspace card"
```

---

### Task 7: Pin Panels

**Files:**
- Modify: `src/shared/types.ts` — add `isPinned?: boolean` to CanvasNodeState
- Modify: `src/renderer/stores/canvasStore.ts` — add `togglePin(nodeId)` action
- Modify: `src/renderer/canvas/CanvasNode.tsx` — pass isPinned to title bar
- Modify: `src/renderer/canvas/CanvasNodeTitleBar.tsx` — add pin button
- Modify: `src/renderer/hooks/useNodeDrag.ts` — guard against pinned nodes
- Modify: `src/renderer/hooks/useNodeResize.ts` — guard against pinned nodes

- [ ] **Step 1: Add isPinned to CanvasNodeState**

In `src/shared/types.ts`, add to `CanvasNodeState`:
```ts
isPinned?: boolean
```

- [ ] **Step 2: Add togglePin action to canvasStore**

```ts
togglePin(id) {
  set((state) => {
    const node = state.nodes[id]
    if (!node) return state
    return {
      nodes: { ...state.nodes, [id]: { ...node, isPinned: !node.isPinned } },
    }
  })
},
```

- [ ] **Step 3: Guard drag and resize**

In `useNodeDrag.ts`, at the start of `handleDragStart`:
```ts
const node = useCanvasStore.getState().nodes[nodeId]
if (!node || node.isPinned) return
```

In `useNodeResize.ts`, at the start of `handleResizeStart`:
```ts
const node = useCanvasStore.getState().nodes[nodeId]
if (!node || node.isPinned) return
```

- [ ] **Step 4: Add pin button to title bar**

In `CanvasNodeTitleBar.tsx`, add `isPinned: boolean` and `onTogglePin: () => void` to props. Add a button before the maximize button using lucide-react's `Pin` icon:
```tsx
<button
  data-titlebar-button
  className={`ml-1 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm transition-opacity hover:bg-white/[0.15] ${isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
  onClick={(e) => { e.stopPropagation(); onTogglePin() }}
  title={isPinned ? 'Unpin' : 'Pin'}
>
  <Pin size={12} className={isPinned ? 'text-blue-400' : 'text-white/80'} />
</button>
```

- [ ] **Step 5: Wire up in CanvasNode**

In `CanvasNode.tsx`, read `isPinned` from the node, add `handleTogglePin` callback calling `canvasStore.togglePin(nodeId)`, pass both to `CanvasNodeTitleBar`.

- [ ] **Step 6: Verify and commit**

Run `npx tsc --noEmit`. Test: click pin on a panel — it should show pinned indicator and resist drag/resize.
```bash
git add src/shared/types.ts src/renderer/stores/canvasStore.ts src/renderer/hooks/useNodeDrag.ts src/renderer/hooks/useNodeResize.ts src/renderer/canvas/CanvasNode.tsx src/renderer/canvas/CanvasNodeTitleBar.tsx
git commit -m "feat: add panel pinning to prevent accidental drag/resize"
```

---

## Phase 2: Canvas Interaction

### Task 8: Panel Snapping Guides

**Files:**
- Modify: `src/renderer/stores/canvasStore.ts` — add `snapGuides` transient state
- Modify: `src/renderer/hooks/useNodeDrag.ts` — compute snap guides during drag
- Create: `src/renderer/canvas/SnapGuides.tsx` — visual guide lines component
- Modify: `src/renderer/canvas/Canvas.tsx` — render SnapGuides

- [ ] **Step 1: Add snapGuides state to canvasStore**

```ts
// State
snapGuides: { x: number | null; y: number | null }

// Initial
snapGuides: { x: null, y: null },

// Actions
setSnapGuides(guides: { x: number | null; y: number | null }) {
  set({ snapGuides: guides })
},
clearSnapGuides() {
  set({ snapGuides: { x: null, y: null } })
},
```

- [ ] **Step 2: Compute guides during drag in useNodeDrag**

In the `handleMouseMove` within `useNodeDrag`, after computing `newOrigin`, call `snapToEdges` and write results to store:
```ts
// Inside the rAF callback, after computing newOrigin
const settings = useSettingsStore.getState()
if (settings.snapToGridEnabled) {
  const neighbors: Rect[] = Object.values(useCanvasStore.getState().nodes)
    .filter((n) => n.id !== nodeId)
    .map((n) => ({ origin: n.origin, size: n.size }))
  const edgeResult = snapToEdges(
    { origin: { x: currentNode.origin.x + deltaX, y: currentNode.origin.y + deltaY }, size: currentNode.size },
    neighbors,
    8,
  )
  useCanvasStore.getState().setSnapGuides(edgeResult)
}
```

In `handleMouseUp`, clear guides:
```ts
useCanvasStore.getState().clearSnapGuides()
```

- [ ] **Step 3: Create SnapGuides component**

Create `src/renderer/canvas/SnapGuides.tsx`:
```tsx
import React from 'react'
import { useCanvasStore } from '../stores/canvasStore'

const SnapGuides: React.FC = () => {
  const guides = useCanvasStore((s) => s.snapGuides)
  if (guides.x === null && guides.y === null) return null

  const color = 'rgba(74, 158, 255, 0.6)'
  // Lines span a large range in canvas space (rendered inside the world div)
  const extent = 100000

  return (
    <>
      {guides.x !== null && (
        <div style={{
          position: 'absolute',
          left: guides.x,
          top: -extent / 2,
          width: 1,
          height: extent,
          backgroundColor: color,
          pointerEvents: 'none',
        }} />
      )}
      {guides.y !== null && (
        <div style={{
          position: 'absolute',
          left: -extent / 2,
          top: guides.y,
          width: extent,
          height: 1,
          backgroundColor: color,
          pointerEvents: 'none',
        }} />
      )}
    </>
  )
}

export default React.memo(SnapGuides)
```

- [ ] **Step 4: Render SnapGuides in Canvas.tsx**

Add `<SnapGuides />` inside the world div, after `<CanvasGrid>` and before `{children}`.

- [ ] **Step 5: Verify and commit**

```bash
git add src/renderer/stores/canvasStore.ts src/renderer/hooks/useNodeDrag.ts src/renderer/canvas/SnapGuides.tsx src/renderer/canvas/Canvas.tsx
git commit -m "feat: show visual snap alignment guides while dragging panels"
```

---

### Task 9: Drag File from Explorer onto Canvas

**Files:**
- Modify: `src/renderer/sidebar/FileTreeNode.tsx` — add draggable + onDragStart for files
- Modify: `src/renderer/canvas/Canvas.tsx` — add onDragOver/onDrop handlers

- [ ] **Step 1: Make files draggable in FileTreeNode**

On the file row element in `FileTreeNode.tsx`, add:
```tsx
draggable={!node.isDirectory}
onDragStart={(e) => {
  e.dataTransfer.setData('application/canvaside-file', node.path)
  e.dataTransfer.effectAllowed = 'copy'
}}
```

- [ ] **Step 2: Handle drop on Canvas**

In `Canvas.tsx`, add handlers to the outer canvas div:
```tsx
const handleFileDragOver = useCallback((e: React.DragEvent) => {
  if (e.dataTransfer.types.includes('application/canvaside-file')) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
}, [])

const handleFileDrop = useCallback((e: React.DragEvent) => {
  const filePath = e.dataTransfer.getData('application/canvaside-file')
  if (!filePath) return
  e.preventDefault()
  const rect = canvasRef.current?.getBoundingClientRect()
  if (!rect) return
  const viewPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top }
  const { zoomLevel, viewportOffset } = useCanvasStore.getState()
  const canvasPoint = viewToCanvas(viewPoint, zoomLevel, viewportOffset)
  const wsId = useAppStore.getState().selectedWorkspaceId
  useAppStore.getState().createEditor(wsId, filePath, canvasPoint)
}, [canvasRef])
```

Add `onDragOver={handleFileDragOver} onDrop={handleFileDrop}` to the canvas div.

- [ ] **Step 3: Verify and commit**

Test: drag a file from the file explorer sidebar onto the canvas — editor should open at drop position.
```bash
git add src/renderer/sidebar/FileTreeNode.tsx src/renderer/canvas/Canvas.tsx
git commit -m "feat: drag files from explorer onto canvas to open editor"
```

---

### Task 10: Fuzzy File Open in Command Palette

**Files:**
- Modify: `src/renderer/ui/CommandPalette.tsx` — add file search when workspace has root

- [ ] **Step 1: Fetch file list when palette opens**

In `CommandPalette.tsx`, add a state for file list and fetch on mount:
```ts
const [files, setFiles] = useState<string[]>([])
const rootPath = useAppStore((s) => s.workspaces.find(w => w.id === s.selectedWorkspaceId)?.rootPath)

useEffect(() => {
  if (!rootPath) return
  window.electronAPI.gitLsFiles(rootPath)
    .then(setFiles)
    .catch(() => setFiles([]))
}, [rootPath])
```

- [ ] **Step 2: Merge file results with command results**

After filtering commands by search text, also filter files using a simple fuzzy match:
```ts
const matchingFiles = search.length > 0
  ? files.filter(f => {
      const name = f.split('/').pop() || f
      return name.toLowerCase().includes(search.toLowerCase())
    }).slice(0, 10)
  : []
```

Render these after the command list with a "Files" section header. Selecting a file calls `createEditor(selectedWorkspaceId, path.join(rootPath, file))`.

- [ ] **Step 3: Verify and commit**

```bash
git add src/renderer/ui/CommandPalette.tsx
git commit -m "feat: fuzzy file search in command palette"
```

---

## Phase 3: Canvas Features

### Task 11: Canvas Regions/Groups

**Files:**
- Modify: `src/shared/types.ts` — add `CanvasRegion` type
- Modify: `src/renderer/stores/canvasStore.ts` — add regions state and actions
- Create: `src/renderer/canvas/CanvasRegion.tsx` — region component with drag/resize
- Create: `src/renderer/hooks/useRegionDrag.ts` — drag handler that moves region + contained panels
- Modify: `src/renderer/canvas/Canvas.tsx` — render regions
- Modify: `src/renderer/lib/session.ts` — persist regions in snapshots

This is the most complex Phase 3 feature. Detailed implementation steps should be planned in a dedicated sub-plan when this task is picked up.

**Key design decisions:**
- Regions stored in `canvasStore.regions: Record<string, CanvasRegion>`
- `CanvasRegion = { id, origin, size, label, color, zOrder }`
- Regions render below panels (lower z-order base)
- Dragging a region computes overlap with nodes using `rectsOverlap` and moves them together
- Right-click canvas → "New Region" creates one at the click point
- Session snapshot extended with `regions` array

---

### Task 12: Minimap Toggle

**Files:**
- Create: `src/renderer/canvas/Minimap.tsx` — bird's-eye overlay
- Modify: `src/renderer/App.tsx` — render Minimap when `showMinimap` setting is true

**Key design:**
- 200x150px fixed overlay in bottom-right corner
- Reads all nodes from canvasStore, computes bounding box, renders colored rectangles at scale
- Current viewport shown as semi-transparent white rectangle
- Click/drag on minimap navigates by setting viewportOffset
- Toggle via existing `Cmd+Shift+M` shortcut (already wired to `toggleMinimap` in `useShortcuts.ts`)

---

### Task 13: Auto-Layout

**Files:**
- Modify: `src/renderer/canvas/layoutEngine.ts` — add `autoLayout()` function
- Modify: `src/renderer/stores/canvasStore.ts` — add `autoLayout()` action
- Modify: `src/renderer/ui/CommandPalette.tsx` — add "Auto-Layout" command

**Key design:**
- Sort nodes by creation order
- Place in rows, wrapping when width exceeds viewport
- Gap of 40px between panels
- After layout, call `zoomToFit()` to show all panels

---

## Phase 4: Panel Enhancements

### Task 14: Cmd+Tab Panel Switcher

**Files:**
- Modify: `src/shared/types.ts` — repurpose `focusNext`/`focusPrevious` or add new action
- Create: `src/renderer/ui/PanelSwitcher.tsx` — horizontal card strip
- Modify: `src/renderer/stores/uiStore.ts` — add `showPanelSwitcher`
- Modify: `src/renderer/hooks/useShortcuts.ts` — wire up
- Modify: `src/renderer/App.tsx` — render PanelSwitcher

**Key design:**
- Use `Ctrl+Tab` (not Cmd+Tab, which macOS intercepts)
- Horizontal row of cards with panel type icon + title
- Hold Ctrl, press Tab to cycle, release Ctrl to confirm
- Selected panel gets focused and viewport centers on it
- Reuse `focusAndCenter` from Task 2

---

### Task 15: Split Panel

**Files:**
- Modify: `src/shared/types.ts` — add `SplitState` type, optional `split` field on CanvasNodeState
- Modify: `src/renderer/stores/canvasStore.ts` — add split actions
- Modify: `src/renderer/canvas/CanvasNode.tsx` — render split layout
- Modify: `src/renderer/canvas/CanvasNodeTitleBar.tsx` — add split option to context menu

**Key design:**
- `SplitState = { direction: 'horizontal' | 'vertical', panels: [string, string], ratio: number }`
- When split, CanvasNode renders two panel contents with a draggable divider
- "Split Right" / "Split Down" in title bar context menu creates a new panel and splits

---

### Task 16: Panel Stacks/Tabs

**Files:**
- Modify: `src/shared/types.ts` — add `stackedPanelIds?: string[]`, `activeStackIndex?: number`
- Modify: `src/renderer/stores/canvasStore.ts` — add stack/unstack actions
- Create: `src/renderer/canvas/CanvasNodeTabBar.tsx` — tab bar component
- Modify: `src/renderer/canvas/CanvasNode.tsx` — render tab bar when stacked

**Key design:**
- When `stackedPanelIds.length > 1`, show tab bar below title bar
- Drag panel onto another to stack
- Drag tab out to unstack
- Tabs show panel type icon + title

---

## Phase 5: Editor & Terminal

### Task 17: Search Across All Open Editors
- New `GlobalSearch.tsx` overlay, `Cmd+Shift+F` shortcut
- Reads content from editor panels, groups results by file

### Task 18: Terminal Output Search
- Use xterm.js `SearchAddon`
- Search bar at top of terminal panel on `Cmd+F` when terminal focused

### Task 19: URL Bar for Browser Panels
- URL input + back/forward/refresh in BrowserPanel
- Webview navigation events update URL display

---

## Phase 6: Workspace & Layout

### Task 20: Saved Layouts/Templates
- New IPC channels for layout CRUD
- Command palette integration for save/load
- Templates stored in electron-store

### Task 21: Sidebar Panel Reordering
- Drag-and-drop on WorkspaceTab components
- Reorder workspaces array in appStore

---

## Phase 7: Large Features

### Task 22: AI Chat Panel (Paid)
- New PanelType `'aiChat'`, new AIChatPanel component
- API key management, context injection, conversation persistence

### Task 23: Multi-Window Support
- Electron BrowserWindow for detached panels
- IPC state sync between windows

### Task 24: Git Integration Panel
- New PanelType `'git'`, GitPanel with diff viewer/staging
- Extend git IPC channels

### Task 25: Plugin/Extension System
- Plugin API, loader, sandboxed execution

### Task 26: Canvas Annotations
- Sticky notes, text labels, freehand drawing on canvas
- SVG drawing layer

### Task 27: Workspace Export/Import
- Export/import workspace layouts as JSON files

---

## Verification

After each task:
1. Run `npx tsc --noEmit` — must pass with no errors
2. Run `npm run dev` — app must start without crashes
3. Manually test the specific feature as described in each task's commit step
4. Commit with descriptive message

After each phase:
1. Test all features from that phase together
2. Verify session save/restore still works (if state fields were modified)
3. Verify no regressions in existing functionality
