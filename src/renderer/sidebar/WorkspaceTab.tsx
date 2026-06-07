import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { CaretRight, Terminal as TerminalIcon, Folder, FolderPlus, SquaresFour, DotsThree, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { WorkspaceState, PanelType, DockLayoutNode } from '../../shared/types'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, WORKSPACE_COLORS } from '../stores/appStore'
import { ACCENT_COLOR_NAMES } from '../../shared/colors'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { getCanvasSnapshotForPanel, getNodeDockLayout, getWorkspaceCanvasPanelIds, getWorkspaceDockSnapshot } from '../lib/workspace/canvasAccess'
import { revealPanel } from '../lib/workspace/panelReveal'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import type { AgentState } from '../../shared/types'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { closePanelWithConfirm } from '../lib/closePanelWithConfirm'
import { partitionWorkspacePanels, buildColdStartCanvasChildOwners } from './partitionWorkspacePanels'
import { worktreeTitleStyle } from '../lib/worktreeTitleStyle'
import { isMiddleClick } from '../lib/mouse'
import { PANEL_REGISTRY } from '../panels/registry'
import { useAgentInfoByPanel } from '../hooks/useAgentPanelInfo'
import { workspaceDisplayName } from '../lib/fs/displayPath'
import { workspaceRuntime } from '../lib/workspace/workspaceRuntime'

// -----------------------------------------------------------------------------
// Companion status dot — surfaces a remote workspace's connection state in the
// sidebar and offers the matching one-click recovery. Driven by the canonical
// workspaceRuntime status (shared with the canvas lock overlay).
// -----------------------------------------------------------------------------

function CompanionDot({ workspace }: { workspace: WorkspaceState }): JSX.Element | null {
  const { status, error } = workspaceRuntime(workspace)
  // Only remote, non-connected states get a dot.
  if (status === 'local' || status === 'connected') return null

  const busy = status === 'installing' || status === 'connecting'
  const color = busy ? 'bg-amber-400 animate-pulse' : 'bg-red-500 hover:ring-2 hover:ring-red-500/40'
  const title =
    status === 'installing' ? 'Installing companion…'
    : status === 'connecting' ? 'Connecting to companion…'
    : status === 'disconnected' ? `Companion disconnected${error ? `: ${error}` : ''}. Click to reconnect.`
    : status === 'missing' ? `Companion not installed${error ? `: ${error}` : ''}. Click to install.`
    : `Companion not reachable${error ? `: ${error}` : ''}. Click to retry.`

  const onClick = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (busy) return
    const app = useAppStore.getState()
    if (status === 'missing') void app.installCompanion(workspace.id)
    else void app.retryCompanion(workspace.id)
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

// Subscribe to every canvas store in a workspace and return a map of
// canvas-child panel id -> the canvas panel id that hosts it. A workspace can
// host multiple canvas panels, and the legacy singleton `useCanvasStore` only
// mirrors whichever canvas mounted first — so we scan ALL canvas panels in the
// workspace. We record WHICH canvas owns each child (not merely THAT it lives
// on some canvas), so the sidebar nests each child under its own canvas instead
// of collapsing them all under the first one.
function useWorkspaceCanvasChildOwners(workspaceId: string): Map<string, string> {
  const canvasPanelIds = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId)
    if (!ws) return [] as string[]
    return Object.values(ws.panels)
      .filter((p) => p.type === 'canvas')
      .map((p) => p.id)
  }))

  const stores = useMemo(
    () => canvasPanelIds.map((id) => getOrCreateCanvasStoreForPanel(id)),
    [canvasPanelIds],
  )

  const compute = useCallback(() => {
    const owners = new Map<string, string>()
    for (let i = 0; i < stores.length; i++) {
      const canvasPanelId = canvasPanelIds[i]
      for (const node of Object.values(stores[i].getState().nodes)) {
        // Each canvas node has its own mini-dock layout; a node may host
        // several tabbed panels. `node.panelId` is only the seed — walk the
        // full layout so additional tabs (e.g. Terminal 2, Terminal 4
        // dragged into the same canvas node) still classify as children of
        // this canvas. Read the LIVE per-node DockStore (the runtime
        // authority) so an open multi-tab node shows all its tabs immediately;
        // node.dockLayout is only a save-time projection now.
        const ids = new Set<string>()
        collectPanelIdsFromDockLayout(getNodeDockLayout(canvasPanelId, node.id), ids)
        if (node.panelId) ids.add(node.panelId)
        for (const id of ids) owners.set(id, canvasPanelId)
      }
    }
    return owners
  }, [stores, canvasPanelIds])

  const [owners, setOwners] = useState<Map<string, string>>(compute)

  useEffect(() => {
    // Recompute immediately on store-set change so we don't render one frame
    // of stale ids after switching workspaces.
    setOwners(compute())
    const unsubs = stores.map((s) => s.subscribe(() => setOwners(compute())))
    return () => {
      for (const fn of unsubs) fn()
    }
  }, [stores, compute])

  return owners
}

function collectPanelIdsFromDockLayout(
  layout: DockLayoutNode | null | undefined,
  out: Set<string>,
): void {
  if (!layout) return
  if (layout.type === 'tabs') {
    for (const id of layout.panelIds) out.add(id)
    return
  }
  for (const child of layout.children) collectPanelIdsFromDockLayout(child, out)
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

export interface TerminalPanelRowProps {
  panel: { id: string; type: PanelType; title?: string; filePath?: string; url?: string }
  indent: boolean
  agentState: AgentState | undefined
  agentLogo?: string | null
  hasPorts: boolean
  worktreeColor?: string
  onClick: (e: React.MouseEvent) => void
  /** Middle-click closes the row (mirrors the dock tab behavior). */
  onClose?: () => void
  rename?: PanelRenameProps
}

const AWAIT_COLOR = '#c08a5a'

export const TerminalPanelRow: React.FC<TerminalPanelRowProps> = ({ panel, indent, agentState, agentLogo: agentLogoProp, hasPorts, worktreeColor, onClick, onClose, rename }) => {
  const Icon = PANEL_ICONS[panel.type] ?? TerminalIcon
  const label = panel.title || panel.filePath?.split('/').pop() || panel.url || panel.type

  const isRunning = agentState === 'running'
  const isAwaiting = agentState === 'waitingForInput'
  const agentLogo = panel.type === 'terminal' ? agentLogoProp : null
  const isRenaming = rename?.renameValue != null

  return (
    <button
      className={`group/panel flex items-center gap-1.5 h-7 pr-2 text-[13px] hover:bg-hover text-left min-w-0 focus:outline-none ${
        indent ? 'pl-10' : 'pl-7'
      } ${isAwaiting ? 'text-primary' : 'text-muted hover:text-primary'}`}
      onClick={onClick}
      onContextMenu={rename?.onContextMenu}
      onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
      onAuxClick={(e) => {
        if (isMiddleClick(e) && onClose) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      title={panel.filePath || panel.url || label}
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
  onClick: (e?: React.MouseEvent) => void
  onClose: () => void
  onBulkContextMenu?: (e: React.MouseEvent) => Promise<boolean>
}

export const WorkspaceTab: React.FC<WorkspaceTabProps> = ({
  workspace,
  isSelected,
  isMultiSelected = false,
  onClick,
  onClose,
  onBulkContextMenu,
}) => {
  // Single store read for all workspace status data
  const wsStatus = useStatusStore(useShallow((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return null
    return {
      listeningPorts: ws.listeningPorts,
    }
  }))
  const agentInfoByPanel = useAgentInfoByPanel(workspace.id)


  // useWorkspaceList's equality fn ignores `panels`, so subscribe to this
  // workspace's panels separately to keep the tree in sync as panels are
  // added/removed/renamed.
  const panels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspace.id)
    return ws?.panels ?? workspace.panels
  }))

  // worktrees ignored by useWorkspaceList's equality fn → workspace.worktrees
  // is stale. Subscribe directly so the per-row accent updates as worktrees
  // are added/recolored.
  const worktrees = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspace.id)
    return ws?.worktrees ?? workspace.worktrees ?? []
  }))

  // Set of panel ids living on this workspace's canvases. The reactive hook
  // covers every live canvas store (the active workspace + any other whose
  // canvas mounted earlier this session — those stores stay alive in the
  // registry after switching away). The resolver fills the cold-start gap for a
  // workspace whose canvas was never mounted (returns its persisted projection).
  // Used regardless of isSelected so active and non-active workspaces apply the
  // same classification rule.
  const liveCanvasChildOwners = useWorkspaceCanvasChildOwners(workspace.id)
  const canvasChildOwners = useMemo(() => {
    const owners = new Map<string, string>(liveCanvasChildOwners)
    // Cold-start fallback: a workspace whose canvases were never mounted this
    // session have no live store, so fill ownership from the per-canvas persisted
    // projection. Iterate EVERY canvas panel (not just the primary) via
    // getCanvasSnapshotForPanel so a never-mounted SECONDARY canvas's children
    // are attributed to it, not lumped under the primary. The live owners (from
    // any mounted canvas) take precedence — buildColdStartCanvasChildOwners only
    // fills ids not already owned, and we seed it with the live map.
    const coldOwners = buildColdStartCanvasChildOwners(
      getWorkspaceCanvasPanelIds(workspace.id).map((canvasPanelId) => ({
        canvasPanelId,
        nodes: Object.values(getCanvasSnapshotForPanel(canvasPanelId)?.nodes ?? {}),
      })),
    )
    for (const [id, owner] of coldOwners) if (!owners.has(id)) owners.set(id, owner)
    return owners
    // liveCanvasChildOwners changes whenever a live store mutates, which re-runs
    // the resolver too; the cold-start projection is otherwise static.
  }, [liveCanvasChildOwners, workspace.id])

  // Ports in the status store are keyed by ptyId, but panel rows are keyed by
  // panelId. Translate via terminalRegistry so the indicators on the workspace
  // overview line up. (Agent state/name/logo come pre-mapped from
  // useAgentInfoByPanel.)
  const portsByPty = wsStatus?.listeningPorts ?? {}
  const portsByPanel = useMemo(() => {
    const out: Record<string, number[]> = {}
    for (const [ptyId, ports] of Object.entries(portsByPty)) {
      const pid = terminalRegistry.panelIdForPty(ptyId)
      if (pid) out[pid] = ports
    }
    return out
  }, [portsByPty])

  const [isExpanded, setIsExpanded] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [isContextActive, setIsContextActive] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Per-panel rename state (distinct from the workspace rename above). When set,
  // the matching panel row renders an inline input in place of its label.
  const [renamingPanelId, setRenamingPanelId] = useState<string | null>(null)
  const [panelRenameValue, setPanelRenameValue] = useState('')

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
    const items: NativeContextMenuItem[] = [
      { id: 'select', label: 'Select Workspace', enabled: !isSelected },
      { id: 'rename', label: 'Rename Workspace' },
      { label: 'Change Color', submenu: colorSubmenu },
      { type: 'separator' },
      { id: 'select-folder', label: 'Select Project Folder' },
      { id: 'copy-cwd', label: 'Copy Working Directory' },
      { type: 'separator' },
      { id: 'duplicate', label: 'Duplicate Workspace' },
      { id: 'close-panels', label: 'Close All Panels', enabled: Object.keys(workspace.panels).length > 0 },
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
        setRenameValue(workspace.name || workspaceDisplayName(workspace.rootPath) || 'Workspace')
        setIsRenaming(true)
        break
      case 'select-folder': {
        const path = await window.electronAPI.openFolderDialog()
        if (path) app.setWorkspaceRootPath(workspace.id, path)
        break
      }
      case 'copy-cwd': {
        const statusState = useStatusStore.getState()
        const ws = statusState.workspaces[workspace.id]
        let dir: string | undefined
        if (ws) {
          const cwds = Object.values(ws.terminalCwd)
          dir = cwds[0]
        }
        if (!dir) dir = workspace.rootPath || undefined
        if (dir) navigator.clipboard.writeText(dir)
        break
      }
      case 'duplicate': app.duplicateWorkspace(workspace.id); break
      case 'close-panels': app.closeAllPanels(workspace.id); break
      case 'remove': app.removeWorkspace(workspace.id, true); break
    }
  }, [workspace.id, workspace.name, workspace.rootPath, workspace.color, workspace.panels, isSelected, onBulkContextMenu])

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
    setPanelRenameValue(currentTitle)
    setRenamingPanelId(panelId)
  }, [])

  const handlePanelRenameSubmit = useCallback((panelId: string) => {
    const trimmed = panelRenameValue.trim()
    if (trimmed) {
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
    // list (Split / Close-Others / Close-to-the-Right / Move-to-Window are
    // dock-stack-relative and have no meaning here).
    const id = await window.electronAPI.showContextMenu([
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
    switch (id) {
      case 'rename':
        beginPanelRename(panelId, currentTitle)
        break
      case 'close':
        handleClosePanel(panelId)
        break
    }
  }, [beginPanelRename, handleClosePanel])

  const panelCount = Object.keys(panels).length

  // Sorted panel list grouped by type
  const panelList = useMemo(() => {
    const TYPE_ORDER: Record<string, number> = { canvas: 0, terminal: 1, editor: 2, browser: 3 }
    return Object.values(panels).slice().sort((a, b) => {
      const ta = TYPE_ORDER[a.type] ?? 99
      const tb = TYPE_ORDER[b.type] ?? 99
      if (ta !== tb) return ta - tb
      return (a.title || '').localeCompare(b.title || '')
    })
  }, [panels])

  const handlePanelClick = useCallback(async (e: React.MouseEvent, panelId: string) => {
    e.stopPropagation()
    await focusWorkspacePanel(workspace.id, panelId)
  }, [workspace.id])

  const beginRename = useCallback(() => {
    setRenameValue(workspace.name || (workspace.rootPath ? workspaceDisplayName(workspace.rootPath) : '') || 'Workspace')
    setIsRenaming(true)
  }, [workspace.name, workspace.rootPath])

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
        className={`group flex items-center gap-2 h-8 px-2 cursor-pointer text-muted hover:text-secondary hover:bg-hover transition-colors outline-none ${
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

  // Partition the tree (see partitionWorkspacePanels): canvas panels host their
  // children (keyed by the canvas that actually owns each), docked panels render
  // as free siblings. The dock-placed id set lets us drop ghosts — panels still
  // in workspace.panels but referenced by no canvas or dock (e.g. left behind by
  // an interrupted close, or a panel whose canvas went away). Read live (snapshot
  // resolver), falling back to the persisted projection; null = unknown (cold
  // start), in which case we don't filter so a real panel is never hidden.
  const dockSnapshot = getWorkspaceDockSnapshot(workspace.id)
  const dockPlacedIds = dockSnapshot ? new Set(Object.keys(dockSnapshot.locations)) : null
  const { canvasPanels, childrenByCanvas, orphanCanvasChildren, freePanels } =
    partitionWorkspacePanels(panelList, canvasChildOwners, dockPlacedIds)

  // Worktree color resolver: only meaningful when the workspace has 2+
  // worktrees (matches WorktreePill's visibility rule — single-branch
  // workspaces would just get noisy with monochrome dots).
  const showWorktreeAccent = worktrees.length >= 2
  const worktreeColorFor = (panelId: string): string | undefined => {
    if (!showWorktreeAccent) return undefined
    const wtId = panels[panelId]?.worktreeId
    // isPrimary is no longer persisted (it's a live-git fact); the primary
    // worktree is the record keyed by the workspace's own rootPath.
    const wt = worktrees.find((w) => w.id === wtId) ?? worktrees.find((w) => w.path === workspace.rootPath)
    return wt?.color
  }

  const renderPanelRow = (p: typeof panelList[number], indent = false) => {
    const label = p.title || p.filePath?.split('/').pop() || p.url || p.type
    const isRenaming = renamingPanelId === p.id
    const rename: PanelRenameProps = {
      renameValue: isRenaming ? panelRenameValue : null,
      onRenameChange: setPanelRenameValue,
      onRenameSubmit: () => handlePanelRenameSubmit(p.id),
      onRenameCancel: () => setRenamingPanelId(null),
      onBeginRename: () => beginPanelRename(p.id, label),
      onContextMenu: (e) => handlePanelContextMenu(e, p.id, label),
    }
    if (p.type === 'terminal' || p.type === 'agent') {
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
        className={`group/panel flex items-center gap-1.5 h-7 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none ${
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
        title={p.filePath || p.url || label}
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

  return (
    <div onContextMenu={handleContextMenu}>
      {/* Project row */}
      <div
        className={`group flex items-center gap-1 h-8 px-1.5 cursor-pointer transition-colors outline-none ${
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
            if (panelCount > 0) setIsExpanded((v) => !v)
          }}
          title={panelCount > 0 ? (isExpanded ? 'Collapse' : 'Expand') : undefined}
          disabled={panelCount === 0}
        >
          {panelCount > 0 && (
            <CaretRight
              size={10}
              className={`transition-transform ${isExpanded ? 'rotate-90' : ''}`}
            />
          )}
        </button>

        {/* Folder icon (tinted by accent if set) */}
        <Folder
          size={14}
          weight="bold"
          className="flex-shrink-0 opacity-90"
          style={hasColor ? { color: accent } : undefined}
        />

        {/* Name (or inline rename input) */}
        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="flex-1 min-w-0 text-[14px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') setIsRenaming(false)
            }}
            onClick={(e) => e.stopPropagation()}
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

        {/* Companion connection indicator (remote workspaces only). Reads the
            same canonical runtime status as the canvas lock, so the dot and the
            overlay never disagree. */}
        <CompanionDot workspace={workspace} />

        {/* Panel count badge (only when collapsed and has panels) */}
        {panelCount > 0 && !isExpanded && (
          <span className="flex-shrink-0 text-[10px] text-secondary font-semibold opacity-80 group-hover:opacity-100 transition-opacity">
            {panelCount}
          </span>
        )}

        {/* Hover actions: dots menu (rename happens via clicking the title) */}
        <button
          className="flex-shrink-0 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-80 hover:!opacity-100 text-secondary hover:text-primary transition-opacity focus:outline-none"
          onClick={(e) => { e.stopPropagation(); handleContextMenu(e) }}
          title="More actions"
        >
          <DotsThree size={14} weight="bold" />
        </button>
      </div>

      {/* Tree of canvases + panels (when expanded) */}
      {isExpanded && panelCount > 0 && (
        <div className="flex flex-col">
          {canvasPanels.map((cp) => (
            <React.Fragment key={cp.id}>
              {renderPanelRow(cp)}
              {(childrenByCanvas[cp.id] || []).map((p) => renderPanelRow(p, true))}
            </React.Fragment>
          ))}
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
        </div>
      )}
    </div>
  )
}
