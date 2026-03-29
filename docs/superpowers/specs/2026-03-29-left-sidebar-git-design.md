# Left Sidebar Git Support — Design Spec

**Date:** 2026-03-29

## Context

CanvasIDE needs a Source Control view in the left sidebar to track git changes, stage/unstage files, commit, and manage worktrees — similar to VS Code's Source Control panel. The git backend (IPC handlers for status, diff, stage, unstage, commit, worktree list, branch monitoring) is already fully implemented. This feature adds the UI.

## Approach: Activity Bar + View Switching

Add a VS Code-style activity bar (vertical icon strip) to the left edge of the sidebar. The activity bar switches between three views: Workspaces, Explorer, and Source Control.

### Activity Bar

- **Width:** 40px vertical icon strip on the left edge of the sidebar
- **Icons** (lucide-react): `LayoutGrid` → Workspaces, `FolderOpen` → Explorer, `GitBranch` → Source Control
- **Active state:** Left border accent color + highlighted background on active icon
- **Collapsed sidebar:** Activity bar remains visible (replaces current collapsed icon strip), clicking an icon expands sidebar to that view
- **State:** New `activeSidebarView: 'workspaces' | 'explorer' | 'git'` in uiStore

### Sidebar Structure Change

Current: `Sidebar = [ProjectList | FileExplorer]` (stacked sections)
New: `Sidebar = [ActivityBar | ContentArea]` (horizontal split)

The content area renders one view at a time:
- `'workspaces'` → ProjectList component (current default)
- `'explorer'` → FileExplorer component
- `'git'` → SourceControlView component (new)

The sidebar width/resize logic applies to the total width (activity bar + content area). The section divider between ProjectList and FileExplorer is removed since views are now exclusive.

### uiStore Changes

**Add:**
- `activeSidebarView: 'workspaces' | 'explorer' | 'git'` (default: `'workspaces'`)
- `setActiveSidebarView(view: SidebarView): void`

**Remove:**
- `fileExplorerVisible` and related toggles (replaced by view switching)

### SourceControlView Component

**Location:** `src/renderer/sidebar/SourceControlView.tsx`

#### Layout (top to bottom):

1. **Header**
   - Title "SOURCE CONTROL" with refresh button (RotateCw icon)
   - Current branch name with GitBranch icon
   - Ahead/behind badge (e.g., "↑2 ↓1") from `gitStatus` tracking info

2. **Commit Area**
   - Multiline text input for commit message (auto-expanding textarea)
   - "Commit" button — disabled when message empty or no staged files
   - Cmd+Enter keyboard shortcut to commit

3. **Staged Changes Section** (collapsible)
   - Header: "STAGED CHANGES" with file count badge and "−" (unstage all) button
   - Each file: icon + filename + relative path + status badge (green)
   - Per-file actions: unstage button (−)
   - Click → open diff in canvas editor panel

4. **Changes Section** (collapsible)
   - Header: "CHANGES" with file count badge and "+" (stage all) button
   - Each file: icon + filename + relative path + status badge (M=yellow, D=red)
   - Per-file actions: stage button (+), discard button (↩)
   - Click → open diff in canvas editor panel

5. **Untracked Files Section** (collapsible)
   - Header: "UNTRACKED" with file count badge and "+" (stage all) button
   - Each file: icon + filename
   - Per-file actions: stage button (+)

6. **Worktree Section** (collapsible)
   - Header: "WORKTREES" with worktree count
   - Each worktree: branch name + path + current indicator
   - Click → switch workspace rootPath to worktree directory

#### Status Badge Colors
- `M` (modified) → yellow/amber
- `A` (added/staged) → green
- `D` (deleted) → red
- `?` (untracked) → gray
- `U` (unmerged) → orange

#### Data Flow
- Uses existing `window.electronAPI.gitStatus(cwd)` for file status
- Uses existing `window.electronAPI.gitDiff(cwd, filePath)` for diffs
- Uses existing `window.electronAPI.gitStage/gitUnstage/gitCommit` for mutations
- Uses existing `window.electronAPI.gitWorktreeList(cwd)` for worktrees
- Uses existing `window.electronAPI.onGitBranchUpdate` for live branch updates
- Refreshes status after stage/unstage/commit operations
- Refreshes on window focus via `visibilitychange` event

#### Diff Opening
Clicking a changed file opens a Monaco editor panel on the canvas with the diff content. Uses existing `addPanel` from canvasStore with `type: 'editor'`.

### Files Modified

| File | Change |
|------|--------|
| `src/renderer/stores/uiStore.ts` | Add `activeSidebarView` state, remove `fileExplorerVisible` |
| `src/renderer/sidebar/Sidebar.tsx` | Restructure to ActivityBar + ContentArea layout |
| `src/renderer/sidebar/SourceControlView.tsx` | **New** — Source Control view component |
| `src/renderer/sidebar/ActivityBar.tsx` | **New** — Activity bar icon strip component |
| `src/renderer/hooks/useShortcuts.ts` | Update shortcut for file explorer toggle → view switching |
| `src/renderer/sidebar/ProjectList.tsx` | Minor: remove redundant icon toolbar (moved to activity bar) |

### Existing Code to Reuse

- **Git IPC:** All handlers in `src/main/ipc/git.ts` and `src/main/ipc/git-monitor.ts`
- **Preload bridge:** All git methods in `src/preload/index.ts` (lines 171-201)
- **Types:** `GitInfo` in `src/shared/types.ts`, git status/worktree types in `src/shared/electron-api.d.ts`
- **Canvas panel creation:** `addPanel` from `canvasStore` for opening diff editors
- **Styling patterns:** Tailwind classes from existing sidebar components

## Verification

1. `npm run dev` — app starts without errors
2. Activity bar shows 3 icons, clicking switches views
3. Workspaces view shows ProjectList as before
4. Explorer view shows FileExplorer as before
5. Source Control view shows changed files grouped by status
6. Stage/unstage individual files and "all" works
7. Commit with message works, clears input and refreshes
8. Clicking a changed file opens diff editor on canvas
9. Worktree section lists worktrees correctly
10. Branch name updates in real-time when switching branches
11. Sidebar collapse/expand works with activity bar visible
