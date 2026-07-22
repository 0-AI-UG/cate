import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { CaretRight, Terminal as TerminalIcon, Folder, FolderPlus, SquaresFour, DotsThree, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import { browserPanelUrl, type WorkspaceState, type PanelType, type PanelState, type WindowPanelInfo } from '../../shared/types'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, WORKSPACE_COLORS } from '../stores/appStore'
import { ACCENT_COLOR_NAMES } from '../../shared/colors'
import { revealPanel } from '../lib/workspace/panelReveal'
import { useWorkspacePanelTree } from '../lib/workspace/useWorkspacePanelTree'
import { useOtherWindowPanels } from '../stores/windowPanelStore'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import type { AgentState } from '../../shared/types'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import {
  closePanelWithConfirm,
  closeAllPanelsWithConfirm,
  removeWorkspacesWithConfirm,
} from '../lib/closePanelWithConfirm'
import { movePanelToNewWindow } from '../lib/workspace/movePanelToNewWindow'
import { getActivePanelId } from '../lib/activePanel'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'
import { isMiddleClick } from '../lib/mouse'
import { PANEL_REGISTRY } from '../panels/registry'
import { panelRowLabel } from '../lib/panelTitle'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { getAgentLogo } from '../lib/agent/agentLogos'
import { workspaceDisplayName } from '../lib/fs/displayPath'
import { workspaceRuntime } from '../lib/workspace/workspaceRuntime'
import { InlineEditInput } from './InlineEditInput'
import { WorkspaceSkillsTree } from './WorkspaceSkillsTree'
import { canvasKey, toggleCollapsed, useTreeCollapseStore } from './treeCollapse'
import { Tooltip } from '../ui/Tooltip'

// Stable empty map so the ports selector returns a referentially-constant value
// when a workspace has no status entry (a fresh `{}` each render would defeat
// useShallow and spin useSyncExternalStore).
const EMPTY_PORTS: Record<string, number[]> = {}

// -----------------------------------------------------------------------------
// Runtime status dot — surfaces a remote workspace's connection state in the
// sidebar and offers the matching one-click recovery. Driven by the canonical
// workspaceRuntime status (shared with the canvas lock overlay).
// -----------------------------------------------------------------------------

function RuntimeDot({ workspace }: { workspace: WorkspaceState }): JSX.Element | null {
  const { status, error } = workspaceRuntime(workspace)
  // Only remote, non-connected states get a dot.
  if (status === 'local' || status === 'connected') return null

  const busy = status === 'installing' || status === 'connecting'
  const color = busy ? 'bg-amber-400 animate-pulse' : 'bg-red-500 hover:ring-2 hover:ring-red-500/40'
  const title =
    status === 'installing' ? 'Installing runtime…'
    : status === 'connecting' ? 'Connecting to runtime…'
    : status === 'disconnected' ? `Runtime disconnected${error ? `: ${error}` : ''}. Click to reconnect.`
    : status === 'missing' ? `Runtime not installed${error ? `: ${error}` : ''}. Click to install.`
    : `Runtime not reachable${error ? `: ${error}` : ''}. Click to retry.`

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (busy) return
    const app = useAppStore.getState()
    if (status === 'missing') void app.installRuntime(workspace.id)
    else void app.retryRuntime(workspace.id)
  }

  return (
    <button
      className={`flex-shrink-0 w-2 h-2 rounded-full focus:outline-none ${color}`}
      disabled={busy}
      title={title}
      onClick={onClick}
    />
  )
}

// -----------------------------------------------------------------------------
// Panel jump helper — focus a panel inside a workspace, switching workspace
// first if necessary.
// -----------------------------------------------------------------------------

async function focusWorkspacePanel(workspaceId: string, panelId: string): Promise<void> {
  await revealPanel(workspaceId, panelId, { retry: true })
}

export interface PanelRenameProps {
  /** Inline-edit value when this row is being renamed (null = not renaming). */
  renameValue: string | null
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onBeginRename: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

// Canonical row-label logic lives in lib/panelTitle (shared with the cross-
// window panel report and the Cate agent chat). Re-exported for existing
// importers of this module.
export { panelRowLabel }

export interface TerminalPanelRowProps {
  panel: Pick<PanelState, 'id' | 'type' | 'title' | 'filePath' | 'tabs' | 'activeTabId'>
  indent: boolean
  agentState: AgentState | undefined
  agentLogo?: string | null
  hasPorts: boolean
  worktreeColor?: string
  onClick: (e: React.MouseEvent) => void
  /** Middle-click closes the row (mirrors the dock tab behavior). */
  onClose?: () => void
  rename?: PanelRenameProps
  /** Context menu for rows without rename support (detached rows). Local rows
   *  route their menu through rename.onContextMenu instead. */
  onContextMenu?: (e: React.MouseEvent) => void
  /** Overrides the row's hover tooltip (used by detached rows to note the panel
   *  lives in another window). Falls back to the panel's path / url / label. */
  titleHint?: string
}

const AWAIT_COLOR = '#c08a5a'

export const TerminalPanelRow: React.FC<TerminalPanelRowProps> = ({ panel, indent, agentState, agentLogo: agentLogoProp, hasPorts, worktreeColor, onClick, onClose, rename, titleHint, onContextMenu }) => {
  const Icon = PANEL_ICONS[panel.type] ?? TerminalIcon
  const label = panelRowLabel(panel)

  const isRunning = agentState === 'running'
  const isAwaiting = agentState === 'waitingForInput'
  const agentLogo = panel.type === 'terminal' ? agentLogoProp : null
  const isRenaming = rename?.renameValue != null

  return (
    <button
      className={`group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] hover:bg-hover text-left min-w-0 focus:outline-none ${
        indent ? 'pl-10' : 'pl-7'
      } ${isAwaiting ? 'text-primary' : 'text-muted hover:text-primary'}`}
      onClick={onClick}
      onContextMenu={onContextMenu ?? rename?.onContextMenu}
      onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
      onAuxClick={(e) => {
        if (isMiddleClick(e) && onClose) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      title={titleHint ?? (panel.filePath || browserPanelUrl(panel) || label)}
    >
      {agentLogo ? (
        <img
          src={agentLogo}
          alt=""
          width={11}
          height={11}
          draggable={false}
          className="flex-shrink-0"
          style={{ width: 11, height: 11, objectFit: 'contain', display: 'block', opacity: 0.95 }}
        />
      ) : (
        <Icon
          size={11}
          className="flex-shrink-0"
          style={{ opacity: 0.6 }}
        />
      )}
      {isRenaming ? (
        <PanelRenameInput rename={rename!} />
      ) : (
        <span
          className={`truncate min-w-0 flex-1 ${isRunning ? 'cate-notif-pulse' : ''}`}
          style={worktreeTitleStyle(worktreeColor, isRunning)}
          onDoubleClick={(e) => { e.stopPropagation(); rename?.onBeginRename() }}
        >
          {label}
        </span>
      )}
      {isAwaiting ? (
        <span className="cate-await-indicator flex-shrink-0" aria-label="awaiting input">
          <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
        </span>
      ) : !isRunning && hasPorts ? (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" />
      ) : null}
    </button>
  )
}

// Inline edit input for a panel-row rename. Mirrors the workspace rename input
// UX: Enter / blur commits, Escape cancels. Click is swallowed so it doesn't
// trigger the row's focus-panel handler.
const PanelRenameInput: React.FC<{ rename: PanelRenameProps }> = ({ rename }) => {
  // Focus + select ONCE on mount. A callback ref running focus/select would
  // re-run on every render (new fn identity each render) and re-select all text
  // after each keystroke — making it impossible to type more than one character.
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const el = inputRef.current
    if (el) { el.focus(); el.select() }
  }, [])
  return (
    <input
      ref={inputRef}
      className="flex-1 min-w-0 text-[13px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
      value={rename.renameValue ?? ''}
      onChange={(e) => rename.onRenameChange(e.target.value)}
      onBlur={rename.onRenameSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') rename.onRenameSubmit()
        if (e.key === 'Escape') rename.onRenameCancel()
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}

const PANEL_ICONS: Record<PanelType, PhosphorIcon> = Object.fromEntries(
  (Object.keys(PANEL_REGISTRY) as PanelType[]).map((t) => [t, PANEL_REGISTRY[t].icon]),
) as Record<PanelType, PhosphorIcon>


interface WorkspaceTabProps {
  workspace: WorkspaceState
  isSelected: boolean
  isMultiSelected?: boolean
  /** Expansion is owned by ProjectList so its header can expand/collapse all. */
  isExpanded: boolean
  onToggleExpand: () => void
  onClick: (e?: React.MouseEvent) => void
  onBulkContextMenu?: (e: React.MouseEvent) => Promise<boolean>
}

export const WorkspaceTab: React.FC<WorkspaceTabProps> = ({
  workspace,
  isSelected,
  isMultiSelected = false,
  isExpanded,
  onToggleExpand,
  onClick,
  onBulkContextMenu,
}) => {
  // Listening ports per ptyId for this workspace. Returned as a FLAT map so
  // `useShallow` can compare it entry-by-entry: the per-terminal port arrays are
  // stable references while unchanged, so the memoized snapshot stays referentially
  // stable and `useSyncExternalStore` doesn't re-render forever. (Wrapping this in
  // an outer `{ listeningPorts }` object defeated useShallow — the wrapper was a
  // fresh object every render, so the snapshot never compared equal → infinite loop.)
  const portsByPty = useStatusStore(useShallow((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return EMPTY_PORTS
    return Object.fromEntries(
      Object.entries(ws.terminals).map(([id, terminal]) => [id, terminal.listeningPorts]),
    )
  }))
  const agentInfoByPanel = useAgentInfoByPanel(workspace.id)


  // The shared panel tree: ws.panels joined against every canvas store + the
  // dock store, multi-canvas/dock-aware and ghost-filtered. The Cmd+K palette
  // reads the exact same source (see useWorkspacePanelTree), so the overview and
  // the palette can never disagree about which panels exist or where they live.
  const { panels, canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels, orderedPanels } =
    useWorkspacePanelTree(workspace.id)

  // Panels living in other (detached) windows for this workspace — they dropped
  // out of the local tree above, so list them in their own "Other windows"
  // section, mirroring the local tree: detached canvases as parent rows with
  // their children nested, then top-level panels. Excludes this window's own
  // panels (the union includes them too).
  const otherWindowPanels = useOtherWindowPanels(workspace.id, Object.keys(panels))
  const { detachedCanvases, detachedChildrenByCanvas, detachedTopLevel, detachedCount } = useMemo(() => {
    const canvases = otherWindowPanels.filter((p) => p.type === 'canvas')
    const canvasIds = new Set(canvases.map((c) => c.panelId))
    const childrenByCanvas: Record<string, WindowPanelInfo[]> = {}
    const topLevel: WindowPanelInfo[] = []
    for (const p of otherWindowPanels) {
      if (p.type === 'canvas') continue
      // A child whose parent canvas is missing from the union (transiently
      // possible mid-transfer) renders top-level instead of being dropped —
      // mirrors partitionWorkspacePanels' orphan fallback for local rows.
      if (p.parentCanvasId && canvasIds.has(p.parentCanvasId)) (childrenByCanvas[p.parentCanvasId] ??= []).push(p)
      else topLevel.push(p)
    }
    return { detachedCanvases: canvases, detachedChildrenByCanvas: childrenByCanvas, detachedTopLevel: topLevel, detachedCount: otherWindowPanels.length }
  }, [otherWindowPanels])

  // worktrees ignored by useWorkspaceList's equality fn → workspace.worktrees
  // is stale. Subscribe directly so the per-row accent updates as worktrees
  // are added/recolored.
  const worktrees = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspace.id)
    return ws?.worktrees ?? workspace.worktrees ?? []
  }))


  // Ports in the status store are keyed by ptyId, but panel rows are keyed by
  // panelId. Translate via terminalRegistry so the indicators on the workspace
  // overview line up. (Agent state/name/logo come pre-mapped from
  // useAgentInfoByPanel.)
  const portsByPanel = useMemo(() => {
    const out: Record<string, number[]> = {}
    for (const [ptyId, ports] of Object.entries(portsByPty)) {
      const pid = terminalRegistry.panelIdForPty(ptyId)
      if (pid) out[pid] = ports
    }
    return out
  }, [portsByPty])

  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isContextActive, setIsContextActive] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Per-panel rename state (distinct from the workspace rename above). When set,
  // the matching panel row renders an inline input in place of its label.
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null)
  const [panelRenameValue, setPanelRenameValue] = useState('')
  // The value the rename input was seeded with. The seed is the row's DERIVED
  // label (file basename / browser URL / type when the panel has no title), so
  // committing it unchanged would freeze that derived label as a permanent
  // user title (titleUserOverridden) — only write when the user actually edited.
  const panelRenameSeedRef = useRef('')

  // Per-canvas collapse state (canvas rows fold their children, like the
  // workspace row folds its tree). Absent = expanded; default is expanded.
  // Persisted in treeCollapse so it survives a restart, like the skills rows.
  const collapsedKeys = useTreeCollapseStore((s) => s.collapsed)
  const isCanvasCollapsed = useCallback(
    (canvasId: string) => collapsedKeys.has(canvasKey(workspace.id, canvasId)),
    [collapsedKeys, workspace.id],
  )
  const toggleCanvas = useCallback(
    (canvasId: string) => toggleCollapsed(canvasKey(workspace.id, canvasId)),
    [workspace.id],
  )

  const beginRename = useCallback(() => {
    setRenameValue(workspace.name || (workspace.rootPath ? workspaceDisplayName(workspace.rootPath) : '') || 'Workspace')
    setIsRenaming(true)
  }, [workspace.name, workspace.rootPath])

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    if (onBulkContextMenu) {
      const handled = await onBulkContextMenu(e)
      if (handled) return
    }
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    setIsContextActive(true)
    const colorSubmenu: NativeContextMenuItem[] = [
      {
        id: 'color:',
        label: 'Default' + (!workspace.color ? ' ✓' : ''),
        enabled: !!workspace.color,
      },
      ...WORKSPACE_COLORS.map((color) => ({
        id: `color:${color}`,
        label: (ACCENT_COLOR_NAMES[color] || color) + (color === workspace.color ? ' ✓' : ''),
        enabled: color !== workspace.color,
      })),
    ]
    const hasCwd =
      !!workspace.rootPath ||
      Object.keys(useStatusStore.getState().workspaces[workspace.id]?.terminals ?? {}).length > 0
    const items: NativeContextMenuItem[] = [
      { id: 'select', label: 'Select Workspace', enabled: !isSelected },
      { id: 'rename', label: 'Rename Workspace' },
      { label: 'Change Color', submenu: colorSubmenu },
      { type: 'separator' },
      { id: 'select-folder', label: 'Select Project Folder' },
      { id: 'copy-cwd', label: 'Copy Working Directory', enabled: hasCwd },
      { type: 'separator' },
      {
        id: 'close-panels',
        // Panels living in detached windows are NOT closed by this — say so.
        label: detachedCount > 0 ? 'Close All Panels in This Window' : 'Close All Panels',
        // `panels` is the live registry (the `workspace` prop's panels can be
        // stale — useWorkspaceList's equality fn ignores them).
        enabled: Object.keys(panels).length > 0,
      },
      { type: 'separator' },
      { id: 'remove', label: 'Close Workspace' },
    ]
    const id = await window.electronAPI.showContextMenu(items)
    setIsContextActive(false)
    if (!id) return
    const app = useAppStore.getState()
    if (id.startsWith('color:')) {
      app.setWorkspaceColor(workspace.id, id.slice(6))
      return
    }
    switch (id) {
      case 'select': app.selectWorkspace(workspace.id); break
      case 'rename':
        beginRename()
        break
      case 'select-folder': {
        const path = await window.electronAPI.openFolderDialog()
        if (path) app.setWorkspaceRootPath(workspace.id, path)
        break
      }
      case 'copy-cwd': {
        const terminals = useStatusStore.getState().workspaces[workspace.id]?.terminals ?? {}
        // Prefer the active panel's terminal — "first terminal in the status
        // map" is an arbitrary pick when several run in different directories.
        const activeId = getActivePanelId()
        const activePty = activeId ? terminalRegistry.ptyIdForPanel(activeId) : null
        let dir = (activePty && terminals[activePty]?.cwd) || undefined
        if (!dir) dir = Object.values(terminals).map((terminal) => terminal.cwd).find(Boolean)
        if (!dir) dir = workspace.rootPath || undefined
        if (dir) navigator.clipboard.writeText(dir)
        break
      }
      case 'close-panels': void closeAllPanelsWithConfirm(workspace.id); break
      case 'remove': void removeWorkspacesWithConfirm([workspace.id]); break
    }
  }, [workspace.id, workspace.name, workspace.rootPath, workspace.color, panels, detachedCount, isSelected, onBulkContextMenu, beginRename])

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [isRenaming])

  const handleRenameSubmit = useCallback(() => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== workspace.name) {
      useAppStore.getState().renameWorkspace(workspace.id, trimmed)
    }
    setIsRenaming(false)
  }, [renameValue, workspace.id, workspace.name])

  const beginPanelRename = useCallback((panelId: string, currentTitle: string) => {
    panelRenameSeedRef.current = currentTitle
    setPanelRenameValue(currentTitle)
    setRenamingPanelId(panelId)
  }, [])

  const handlePanelRenameSubmit = useCallback((panelId: string) => {
    const trimmed = panelRenameValue.trim()
    if (trimmed && trimmed !== panelRenameSeedRef.current) {
      useAppStore.getState().renamePanelByUser(workspace.id, panelId, trimmed)
    }
    setRenamingPanelId(null)
  }, [panelRenameValue, workspace.id])

  const handleClosePanel = useCallback(async (panelId: string) => {
    // Routes canvas panels through the move/delete/close flow (closing a canvas
    // from the sidebar previously skipped it and orphaned the children).
    await closePanelWithConfirm(workspace.id, panelId)
  }, [workspace.id])

  const handlePanelContextMenu = useCallback(async (e: React.MouseEvent, panelId: string, currentTitle: string) => {
    // Stop the event from bubbling to the workspace-level handler — otherwise a
    // right-click on a panel row would open the workspace context menu.
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    // Mirror the dock tab menu, limited to actions that apply to a flat sidebar
    // list (Split / Close-Others / Close-to-the-Right are dock-stack-relative
    // and have no meaning here).
    const id = await window.electronAPI.showContextMenu([
      { id: 'rename', label: 'Rename' },
      { id: 'move-window', label: 'Move into New Window' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
    switch (id) {
      case 'rename':
        beginPanelRename(panelId, currentTitle)
        break
      case 'move-window':
        void movePanelToNewWindow(workspace.id, panelId)
        break
      case 'close':
        handleClosePanel(panelId)
        break
    }
  }, [beginPanelRename, handleClosePanel, workspace.id])

  // Context menu for rows hosted in ANOTHER window: cross-window actions only
  // (reveal there / close there, behind the owner's confirm gates). Without
  // this the right-click bubbles into the workspace menu, which reads as a
  // misfire on a specific panel row.
  const handleDetachedContextMenu = useCallback(async (e: React.MouseEvent, panelId: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    const id = await window.electronAPI.showContextMenu([
      { id: 'show', label: 'Show in Window' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
    switch (id) {
      case 'show': void window.electronAPI.focusWindowPanel(panelId); break
      case 'close': void window.electronAPI.closeWindowPanel?.(panelId); break
    }
  }, [])

  // Local panels plus panels in detached windows — drives the expand toggle and
  // the count badge so a workspace whose only panels are detached still expands.
  // Counts what the tree actually renders (orderedPanels excludes ghost records;
  // the raw ws.panels registry can contain more).
  const treeCount = orderedPanels.length + detachedCount

  const handlePanelClick = useCallback(async (e: React.MouseEvent, panelId: string) => {
    e.stopPropagation()
    await focusWorkspacePanel(workspace.id, panelId)
  }, [workspace.id])

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
    // Modified clicks are multi-select gestures — let them fall through to the
    // row handler instead of entering rename.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return
    // First click selects the workspace (parent handler). Once selected, a
    // click on the title enters rename mode — replacing the dedicated pencil.
    if (!isSelected) return
    e.stopPropagation()
    beginRename()
  }, [isSelected, beginRename])

  // Empty state: workspace has no folder selected yet — flat row that opens picker
  if (!workspace.rootPath) {
    const handlePickFolder = async (e: React.MouseEvent) => {
      e.stopPropagation()
      if (!isSelected) onClick()
      const path = await window.electronAPI.openFolderDialog()
      if (path) {
        useAppStore.getState().setWorkspaceRootPath(workspace.id, path)
      }
    }
    return (
      <div
        className={`group mx-1.5 my-0.5 rounded-lg flex items-center gap-2 h-7 px-2 cursor-pointer text-muted hover:text-secondary hover:bg-hover transition-colors outline-none ${
          isContextActive ? 'ring-1 ring-strong' : ''
        } ${isSelected ? 'bg-surface-6' : ''}`}
        onClick={handlePickFolder}
        onContextMenu={handleContextMenu}
        title={workspace.rootPathError || 'Click to choose a project folder'}
      >
        <FolderPlus size={14} className="flex-shrink-0 opacity-60" />
        <span className="flex-1 min-w-0 text-[14px] truncate italic">
          {workspace.isRootPathPending ? 'Connecting…' : 'Add Workspace'}
        </span>
      </div>
    )
  }

  const lastSegment = workspaceDisplayName(workspace.rootPath) || 'Workspace'
  const hasCustomName = workspace.name && workspace.name !== lastSegment && workspace.name !== 'Workspace'
  const displayTitle = hasCustomName ? workspace.name! : lastSegment

  const hasColor = !!workspace.color
  const accent = workspace.color || ''

  // Worktree color resolver: only meaningful when the workspace has 2+
  // worktrees (matches WorktreePill's visibility rule — single-branch
  // workspaces would just get noisy with monochrome dots).
  const showWorktreeAccent = worktrees.length >= 2
  // Resolve a worktree accent color from a panel's worktree tag. isPrimary is no
  // longer persisted (it's a live-git fact); the primary worktree is the record
  // keyed by the workspace's own rootPath.
  const worktreeColorForId = (worktreeId: string | undefined): string | undefined => {
    if (!showWorktreeAccent) return undefined
    const wt = worktrees.find((w) => w.id === worktreeId) ?? worktrees.find((w) => w.path === workspace.rootPath)
    return wt?.color
  }
  const worktreeColorFor = (panelId: string): string | undefined =>
    worktreeColorForId(panels[panelId]?.worktreeId)

  // A panel living in another window — click focuses that window and reveals it.
  // Read-only (no rename/close), since it isn't hosted here, but otherwise
  // rendered with the SAME data as a local row: agent state, agent logo, ports,
  // and worktree accent all ride along on the cross-window union (stamped by the
  // owner window, the only one that sees this panel's activity scan), so the
  // running shimmer / awaiting indicator / port dot match the local rows exactly.
  const renderDetachedRow = (p: WindowPanelInfo, indent: boolean) => {
    const onClick = (e: React.MouseEvent): void => {
      e.stopPropagation()
      void window.electronAPI.focusWindowPanel(p.panelId)
    }
    const titleHint = `${p.title} — in another window`
    if (p.type === 'terminal' || p.type === 'cateAgent') {
      return (
        <TerminalPanelRow
          key={p.panelId}
          panel={{ id: p.panelId, type: p.type, title: p.title }}
          indent={indent}
          agentState={p.agentState}
          agentLogo={getAgentLogo(p.agentName ?? null)}
          hasPorts={!!p.hasPorts}
          worktreeColor={worktreeColorForId(p.worktreeId)}
          onClick={onClick}
          onContextMenu={(e) => handleDetachedContextMenu(e, p.panelId)}
          titleHint={titleHint}
        />
      )
    }
    const Icon = PANEL_ICONS[p.type] ?? SquaresFour
    return (
      <button
        key={p.panelId}
        className={`group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none ${
          indent ? 'pl-10' : 'pl-7'
        }`}
        onClick={onClick}
        onContextMenu={(e) => handleDetachedContextMenu(e, p.panelId)}
        title={titleHint}
      >
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        <span className="truncate min-w-0 flex-1">{p.title}</span>
        {p.hasPorts && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" />
        )}
      </button>
    )
  }

  // Detached canvas parent row — the read-only mirror of renderCanvasRow for a
  // canvas living in another window: a disclosure caret that folds its children,
  // the row click focusing the owning window. Collapse state is shared with the
  // local canvases (keyed by panelId, which is unique across windows).
  const renderDetachedCanvasRow = (p: WindowPanelInfo, hasChildren: boolean, collapsed: boolean) => {
    const Icon = PANEL_ICONS[p.type] ?? SquaresFour
    return (
      <div
        role="button"
        tabIndex={0}
        className="group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pl-3 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 cursor-pointer focus:outline-none"
        onClick={(e) => { e.stopPropagation(); void window.electronAPI.focusWindowPanel(p.panelId) }}
        onContextMenu={(e) => handleDetachedContextMenu(e, p.panelId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            void window.electronAPI.focusWindowPanel(p.panelId)
          }
        }}
        title={`${p.title} — in another window`}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex-shrink-0 flex items-center justify-center w-[10px] text-muted hover:text-primary focus:outline-none"
            onClick={(e) => { e.stopPropagation(); toggleCanvas(p.panelId) }}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-label={collapsed ? 'Expand canvas' : 'Collapse canvas'}
          >
            <CaretRight size={10} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          </button>
        ) : (
          <span className="flex-shrink-0 w-[10px]" />
        )}
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        <span className="truncate min-w-0 flex-1">{p.title}</span>
      </div>
    )
  }

  const renderPanelRow = (p: PanelState, indent = false) => {
    const label = panelRowLabel(p)
    const isRenaming = renamingPanelId === p.id
    const rename: PanelRenameProps = {
      renameValue: isRenaming ? panelRenameValue : null,
      onRenameChange: setPanelRenameValue,
      onRenameSubmit: () => handlePanelRenameSubmit(p.id),
      onRenameCancel: () => setRenamingPanelId(null),
      onBeginRename: () => beginPanelRename(p.id, label),
      onContextMenu: (e) => handlePanelContextMenu(e, p.id, label),
    }
    if (p.type === 'terminal' || p.type === 'cateAgent') {
      const info = agentInfoByPanel[p.id]
      return (
        <TerminalPanelRow
          key={p.id}
          panel={p}
          indent={indent}
          agentState={info?.state}
          agentLogo={info?.logo}
          hasPorts={(portsByPanel[p.id]?.length ?? 0) > 0}
          worktreeColor={worktreeColorFor(p.id)}
          onClick={(e) => handlePanelClick(e, p.id)}
          onClose={() => handleClosePanel(p.id)}
          rename={rename}
        />
      )
    }
    const Icon = PANEL_ICONS[p.type] ?? SquaresFour
    const hasPorts = (portsByPanel[p.id]?.length ?? 0) > 0
    return (
      <button
        key={p.id}
        className={`group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none ${
          indent ? 'pl-10' : 'pl-7'
        }`}
        onClick={(e) => handlePanelClick(e, p.id)}
        onContextMenu={rename.onContextMenu}
        onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
        onAuxClick={(e) => {
          if (isMiddleClick(e)) {
            e.preventDefault()
            e.stopPropagation()
            handleClosePanel(p.id)
          }
        }}
        title={p.filePath || browserPanelUrl(p) || label}
      >
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        {isRenaming ? (
          <PanelRenameInput rename={rename} />
        ) : (
          <span
            className="truncate min-w-0 flex-1"
            onDoubleClick={(e) => { e.stopPropagation(); rename.onBeginRename() }}
          >
            {label}
          </span>
        )}
        {hasPorts && (
          <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" />
        )}
      </button>
    )
  }

  // Canvas parent row — like a panel row, but with a disclosure caret that folds
  // its children. A leaf canvas (no children) keeps an empty caret-width gutter
  // so its icon stays aligned with sibling canvas rows. Rendered as a div (not a
  // button) so the caret can be a real nested button without illegal nesting.
  const renderCanvasRow = (cp: PanelState, hasChildren: boolean, collapsed: boolean) => {
    const label = panelRowLabel(cp)
    const isRenaming = renamingPanelId === cp.id
    const rename: PanelRenameProps = {
      renameValue: isRenaming ? panelRenameValue : null,
      onRenameChange: setPanelRenameValue,
      onRenameSubmit: () => handlePanelRenameSubmit(cp.id),
      onRenameCancel: () => setRenamingPanelId(null),
      onBeginRename: () => beginPanelRename(cp.id, label),
      onContextMenu: (e) => handlePanelContextMenu(e, cp.id, label),
    }
    const Icon = PANEL_ICONS[cp.type] ?? SquaresFour
    return (
      <div
        role="button"
        tabIndex={0}
        className="group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pl-3 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 cursor-pointer focus:outline-none"
        onClick={(e) => handlePanelClick(e, cp.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            void focusWorkspacePanel(workspace.id, cp.id)
          }
        }}
        onContextMenu={rename.onContextMenu}
        onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
        onAuxClick={(e) => {
          if (isMiddleClick(e)) {
            e.preventDefault()
            e.stopPropagation()
            handleClosePanel(cp.id)
          }
        }}
        title={label}
      >
        {hasChildren ? (
          <button
            type="button"
            className="flex-shrink-0 flex items-center justify-center w-[10px] text-muted hover:text-primary focus:outline-none"
            onClick={(e) => { e.stopPropagation(); toggleCanvas(cp.id) }}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-label={collapsed ? 'Expand canvas' : 'Collapse canvas'}
          >
            <CaretRight size={10} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          </button>
        ) : (
          <span className="flex-shrink-0 w-[10px]" />
        )}
        <Icon size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
        {isRenaming ? (
          <PanelRenameInput rename={rename} />
        ) : (
          <span
            className="truncate min-w-0 flex-1"
            onDoubleClick={(e) => { e.stopPropagation(); rename.onBeginRename() }}
          >
            {label}
          </span>
        )}
      </div>
    )
  }

  return (
    <div onContextMenu={handleContextMenu}>
      {/* Project row */}
      <div
        className={`group mx-1.5 my-0.5 rounded-lg flex items-center gap-1 h-7 px-1.5 cursor-pointer transition-colors outline-none ${
          isContextActive ? 'ring-1 ring-strong' : ''
        } ${
          isMultiSelected
            ? 'bg-surface-6 text-primary ring-1 ring-strong'
            : isSelected
            ? 'bg-surface-6 text-primary'
            : 'text-secondary hover:text-primary hover:bg-hover'
        }`}
        style={hasColor ? {
          backgroundColor: isSelected ? `${accent}26` : `${accent}14`,
        } : undefined}
        onClick={(e) => onClick(e)}
      >
        {/* Chevron / expand toggle */}
        <button
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted hover:text-primary focus:outline-none"
          onClick={(e) => {
            e.stopPropagation()
            if (treeCount > 0) onToggleExpand()
          }}
          title={treeCount > 0 ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
          disabled={treeCount === 0}
        >
          {treeCount > 0 && (
            <CaretRight
              size={10}
              className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          )}
        </button>

        {/* Folder icon (tinted by accent if set) */}
        <Folder
          size={14}
          className="flex-shrink-0 opacity-90"
          style={hasColor ? { color: accent } : undefined}
        />

        {/* Name (or inline rename input) */}
        {isRenaming ? (
          <InlineEditInput
            ref={renameInputRef}
            className="flex-1 min-w-0 text-[14px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
            value={renameValue}
            onChange={setRenameValue}
            onSubmit={handleRenameSubmit}
            onCancel={() => setIsRenaming(false)}
          />
        ) : (
          <span
            className={`flex-1 min-w-0 text-[14px] truncate ${isSelected ? 'cursor-text' : ''}`}
            title={isSelected ? 'Click to rename' : workspace.rootPath}
            onClick={handleTitleClick}
            onDoubleClick={(e) => { e.stopPropagation(); beginRename() }}
          >
            {displayTitle}
          </span>
        )}

        {/* Runtime connection indicator (remote workspaces only). Reads the
            same canonical runtime status as the canvas lock, so the dot and the
            overlay never disagree. */}
        <RuntimeDot workspace={workspace} />

        {/* Panel count badge (only when collapsed and has panels) */}
        {treeCount > 0 && !isExpanded && (
          <span className="flex-shrink-0 text-[10px] text-secondary font-semibold opacity-80 group-hover:opacity-100 transition-opacity">
            {treeCount}
          </span>
        )}

        {/* Hover actions: dots menu (rename happens via clicking the title) */}
        <Tooltip label="More actions">
          <button
            className="flex-shrink-0 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-80 hover:!opacity-100 text-secondary hover:text-primary transition-opacity focus:outline-none"
            onClick={(e) => { e.stopPropagation(); handleContextMenu(e) }}
            aria-label="More actions"
          >
            <DotsThree size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Tree of canvases + panels (when expanded) */}
      {isExpanded && treeCount > 0 && (
        <div className="flex flex-col">
          {canvasPanels.map((cp) => {
            const children = childrenByCanvas[cp.id] || []
            const collapsed = isCanvasCollapsed(cp.id)
            return (
              <React.Fragment key={cp.id}>
                {renderCanvasRow(cp, children.length > 0, collapsed)}
                {!collapsed && children.map((p) => renderPanelRow(p, true))}
              </React.Fragment>
            )
          })}
          {orphanCanvasChildren.length > 0 && canvasPanels.length === 0 && (
            <>
              <div className="flex items-center gap-1.5 h-7 pl-6 pr-2 text-[13px] text-muted">
                <SquaresFour size={12} className="flex-shrink-0 opacity-60" />
                <span className="truncate">Canvas</span>
              </div>
              {orphanCanvasChildren.map((p) => renderPanelRow(p, true))}
            </>
          )}
          {freePanels.map((p) => renderPanelRow(p))}
          {detachedCount > 0 && (
            <>
              <div className="flex items-center gap-1.5 h-6 pl-7 pr-2 text-[11px] uppercase tracking-wide text-muted opacity-70">
                <span className="truncate">Other windows</span>
              </div>
              {detachedCanvases.map((cp) => {
                const children = detachedChildrenByCanvas[cp.panelId] || []
                const collapsed = isCanvasCollapsed(cp.panelId)
                return (
                  <React.Fragment key={cp.panelId}>
                    {renderDetachedCanvasRow(cp, children.length > 0, collapsed)}
                    {!collapsed && children.map((c) => renderDetachedRow(c, true))}
                  </React.Fragment>
                )
              })}
              {detachedTopLevel.map((p) => renderDetachedRow(p, false))}
            </>
          )}
          {/* Skills the workspace's agents already have — folded into the tree:
              one row per agent, its skills nested beneath. No separate section. */}
          <WorkspaceSkillsTree workspaceId={workspace.id} rootPath={workspace.rootPath} />
        </div>
      )}
    </div>
  )
}
