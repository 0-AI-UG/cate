# Right Sidebar with Git Tab & Worktree Overview

**Date:** 2026-03-27
**Status:** Approved

## Overview

Transform the Git panel from a canvas-only node into a VS Code-style right sidebar. The sidebar is a generic tabbed container (Git is the first tab, extensible later). It can be collapsed to an icon strip, expanded with resizable width, and detached into a separate Electron window then reattached. The Git tab adds a read-only worktree overview section.

## Layout

The right sidebar sits at the right edge of the app layout:

```
[LeftSidebar] [Canvas + Toolbar] [RightSidebar]
```

- **Collapsed:** 40px icon strip along the right edge, showing tab icons vertically (mirrors left sidebar's collapsed state)
- **Expanded:** 220px default width, resizable from the left edge via drag handle
- **Resize bounds:** 140px min, 500px max (same as left sidebar)
- **Border:** `border-l border-white/10` (mirrors left sidebar's `border-r`)
- **Background:** `bg-canvas-bg` (matches left sidebar)
- macOS titlebar drag region at top (28px `h-7`)

## Tab System

The collapsed icon strip doubles as the tab selector (like VS Code's activity bar on the side):

- Each tab registers an icon and a label
- Clicking a tab icon when collapsed: expands the sidebar and activates that tab
- Clicking the active tab's icon when expanded: collapses the sidebar
- Clicking a different tab's icon when expanded: switches to that tab
- Active tab indicated by a left-edge accent bar (2px, white/60) and brighter icon

### Initial Tabs

| Tab | Icon | Accent Color |
|-----|------|-------------|
| Git | `GitBranch` (lucide) | `#FF3B30` (red) |

Future tabs (AI Chat, Search, etc.) can be added by pushing to the tab registry array.

## Git Tab Content

Adapted from the existing `GitPanel` component. The sidebar version does NOT take `panelId`/`nodeId` props — it reads `workspaceId` directly from `useAppStore`.

### Sections (top to bottom)

1. **Header** — Branch name display + Refresh button (existing)
2. **Worktrees** — Collapsible section listing local worktrees (new)
3. **Staged files** — Green status indicators + Unstage button (existing)
4. **Changes (unstaged)** — Orange status indicators + Stage button (existing)
5. **Diff preview** — Inline diff for selected file, max 200px height (existing)
6. **Commit area** — Message input + Commit button (existing, sticky at bottom)

### Worktree Section

- Calls new IPC `git:worktreeList` on mount and on refresh
- Displays each worktree as a row: `[branch-name]  [path-basename]`
- Current worktree highlighted with a dot indicator or bold text
- Clicking a worktree: no action (read-only for now)
- Collapsible via a chevron toggle, collapsed by default if only one worktree exists

## Detach / Reattach

### Detach
- Expanded sidebar header shows a "pop out" icon button (`ExternalLink` from lucide)
- Clicking it calls `window.electronAPI.detachPanel({ title: 'Git', width: sidebarWidth, height: windowHeight })`
- Uses the existing `WINDOW_DETACH_PANEL` IPC channel
- Sidebar area shows a placeholder: "Git (detached)" with a "Reattach" button

### Reattach
- Clicking "Reattach" in the placeholder (or closing the detached window) restores sidebar content
- The detached Electron window is closed via a new IPC message `window:reattachPanel`
- State tracked via `rightSidebarDetached` in uiStore

## State Management

### uiStore additions

```typescript
// State
rightSidebarVisible: boolean        // false = collapsed icon strip, true = expanded
rightSidebarActiveTab: string       // 'git' (extensible)
rightSidebarDetached: boolean       // true when popped out to Electron window

// Actions
toggleRightSidebar: () => void
setRightSidebarTab: (tab: string) => void
setRightSidebarVisible: (visible: boolean) => void
setRightSidebarDetached: (detached: boolean) => void
```

### Session Persistence

Right sidebar state (visible, activeTab, width) is saved/restored as part of the workspace session, alongside existing sidebar state.

## IPC Additions

### `git:worktreeList`

- **Channel:** `GIT_WORKTREE_LIST = 'git:worktreeList'`
- **Args:** `(rootPath: string)`
- **Returns:** `GitWorktree[]`

```typescript
interface GitWorktree {
  path: string       // absolute path to worktree
  branch: string     // branch name (or HEAD SHA if detached)
  isBare: boolean
  isCurrent: boolean // true if this is the worktree at rootPath
}
```

- Implementation: runs `git worktree list --porcelain`, parses output
- Added to `ipc-channels.ts`, main process git handler, preload bridge, and `electron-api.d.ts`

## Toolbar Change

The Git button (`GitBranch` icon) in `CanvasToolbar` changes behavior:
- **Click:** Toggles the right sidebar open to the Git tab (instead of creating a canvas node)
- The Git canvas node type remains available via command palette and right-click context menu for users who prefer floating panels

## New Files

| File | Purpose |
|------|---------|
| `src/renderer/sidebar/RightSidebar.tsx` | Right sidebar container with tab system and resize |
| `src/renderer/sidebar/GitSidebarTab.tsx` | Git tab content (adapted from GitPanel) |
| `src/renderer/sidebar/WorktreeList.tsx` | Worktree overview sub-component |

## Modified Files

| File | Change |
|------|--------|
| `src/renderer/App.tsx` | Add `RightSidebar` to layout, update `onNewGit` callback |
| `src/renderer/stores/uiStore.ts` | Add right sidebar state and actions |
| `src/renderer/canvas/CanvasToolbar.tsx` | Git button toggles right sidebar instead of creating node |
| `src/shared/ipc-channels.ts` | Add `GIT_WORKTREE_LIST` channel |
| `src/shared/electron-api.d.ts` | Add `gitWorktreeList` type |
| `src/preload/index.ts` | Expose `gitWorktreeList` bridge |
| `src/main/` (git handler) | Implement `git:worktreeList` handler |
| `src/renderer/lib/session.ts` | Persist right sidebar state |

## Out of Scope

- Worktree CRUD operations (create, delete, prune) — future enhancement
- Moving AI Chat or other panels into right sidebar tabs — future enhancement
- Drag-and-drop tab reordering
- Right sidebar in detached panel windows
