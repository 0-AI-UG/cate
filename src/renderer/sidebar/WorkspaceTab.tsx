import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { CaretRight, Terminal as TerminalIcon, Folder, FolderPlus, SquaresFour, DotsThree, type Icon as PhosphorIcon } from '@phosphor-icons/react'
import type { WorkspaceState, PanelType, PanelLocation, DockLayoutNode } from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, WORKSPACE_COLORS, getCanvasOperations, getWorkspaceCanvasPanelId, ensureCanvasOpsForPanel } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { getOrCreateCanvasStoreForPanel } from '../stores/canvasStore'
import { findTabStack, findStackContainingPanel } from '../stores/dockTreeUtils'
import type { NativeContextMenuItem } from '../../shared/electron-api'
import type { AgentState } from '../../shared/types'
import { terminalRegistry } from '../lib/terminalRegistry'
import { PANEL_REGISTRY } from '../panels/registry'

// -----------------------------------------------------------------------------
// Panel jump helper — focus a panel inside a workspace, switching workspace
// first if necessary.
// -----------------------------------------------------------------------------

async function focusWorkspacePanel(workspaceId: string, panelId: string): Promise<void> {
  const app = useAppStore.getState()
  if (app.selectedWorkspaceId !== workspaceId) {
    await app.selectWorkspace(workspaceId)
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, 50))

    const dock = useDockStore.getState()
    let location: PanelLocation | null = dock.getPanelLocation(panelId) ?? null
    if (!location) {
      for (const zoneName of ALL_ZONES) {
        const zone = dock.zones[zoneName]
        if (!zone.layout) continue
        const stack = findStackContainingPanel(zone.layout, panelId)
        if (stack) { location = { type: 'dock', zone: zoneName, stackId: stack.id }; break }
      }
    }
    if (location?.type === 'dock') {
      const zone = dock.zones[location.zone]
      if (!zone.visible) dock.toggleZone(location.zone)
      if (zone.layout) {
        const stack = findTabStack(zone.layout, location.stackId)
        if (stack) {
          const idx = stack.panelIds.indexOf(panelId)
          if (idx >= 0) dock.setActiveTab(location.stackId, idx)
        }
      }
      return
    }

    // Resolve the canvas ops for THIS workspace's canvas panel (not the
    // global singleton — that may point at a different workspace's store).
    const canvasPanelId = getWorkspaceCanvasPanelId(workspaceId)
    const ops = canvasPanelId ? ensureCanvasOpsForPanel(canvasPanelId) : getCanvasOperations()
    const nodeId = ops?.storeApi?.getState()?.nodeForPanel(panelId)
    if (nodeId) { ops!.focusPanelNode(panelId); return }
  }
}

// Subscribe to every canvas store in a workspace and return the union of
// panel ids that currently live on those canvases. A workspace can host
// multiple canvas panels, and the legacy singleton `useCanvasStore` only
// mirrors whichever canvas mounted first — so we scan ALL canvas panels in
// the workspace and union their live nodes' dockLayouts.
function useWorkspaceCanvasPanelIds(workspaceId: string): Set<string> {
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
    const ids = new Set<string>()
    for (const store of stores) {
      for (const node of Object.values(store.getState().nodes)) {
        // Each canvas node has its own mini-dock layout; a node may host
        // several tabbed panels. `node.panelId` is only the seed — walk the
        // full layout so additional tabs (e.g. Terminal 2, Terminal 4
        // dragged into the same canvas node) still classify as canvas
        // children in the sidebar.
        collectPanelIdsFromDockLayout(node.dockLayout, ids)
        if (node.panelId) ids.add(node.panelId)
      }
    }
    return ids
  }, [stores])

  const [ids, setIds] = useState<Set<string>>(compute)

  useEffect(() => {
    // Recompute immediately on store-set change so we don't render one frame
    // of stale ids after switching workspaces.
    setIds(compute())
    const unsubs = stores.map((s) => s.subscribe(() => setIds(compute())))
    return () => {
      for (const fn of unsubs) fn()
    }
  }, [stores, compute])

  return ids
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

interface TerminalPanelRowProps {
  panel: { id: string; type: PanelType; title?: string; filePath?: string; url?: string }
  indent: boolean
  agentState: AgentState | undefined
  hasPorts: boolean
  onClick: (e: React.MouseEvent) => void
}

const AWAIT_COLOR = '#c08a5a'

const TerminalPanelRow: React.FC<TerminalPanelRowProps> = ({ panel, indent, agentState, hasPorts, onClick }) => {
  const Icon = TerminalIcon
  const label = panel.title || panel.filePath?.split('/').pop() || panel.url || panel.type

  const isRunning = agentState === 'running'
  const isAwaiting = agentState === 'waitingForInput'

  return (
    <button
      className={`group/panel flex items-center gap-1.5 h-7 pr-2 rounded text-[13px] hover:bg-hover text-left min-w-0 focus:outline-none ${
        indent ? 'pl-10' : 'pl-7'
      } ${isAwaiting ? 'text-primary' : 'text-muted hover:text-primary'}`}
      onClick={onClick}
      title={panel.filePath || panel.url || label}
    >
      <Icon size={11} className="flex-shrink-0 opacity-60" />
      <span className={`truncate min-w-0 flex-1 ${isRunning ? 'cate-notif-pulse' : ''}`}>
        {label}
      </span>
      {isAwaiting ? (
        <span className="cate-await-indicator flex-shrink-0" aria-label="awaiting input">
          <span className="cate-await-ring" style={{ borderColor: AWAIT_COLOR }} />
          <span className="cate-await-dot" style={{ backgroundColor: AWAIT_COLOR }} />
        </span>
      ) : !isRunning && hasPorts ? (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" />
      ) : null}
    </button>
  )
}

const PANEL_ICONS: Record<PanelType, PhosphorIcon> = Object.fromEntries(
  (Object.keys(PANEL_REGISTRY) as PanelType[]).map((t) => [t, PANEL_REGISTRY[t].icon]),
) as Record<PanelType, PhosphorIcon>

const COLOR_NAMES: Record<string, string> = {
  '#6b8fb0': 'Slate Blue',
  '#c08a5a': 'Tan',
  '#7aa074': 'Sage',
  '#9d7fb5': 'Violet',
  '#c07070': 'Dusty Red',
  '#6aa5a5': 'Teal',
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
  // Single store read for all workspace status data
  const wsStatus = useStatusStore(useShallow((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return null
    return {
      listeningPorts: ws.listeningPorts,
      agentState: ws.agentState,
    }
  }))

  const liveLocations = useDockStore((s) => s.panelLocations)
  const panelLocations = isSelected ? liveLocations : workspace.dockState?.locations

  // useWorkspaceList's equality fn ignores `panels`, so subscribe to this
  // workspace's panels separately to keep the tree in sync as panels are
  // added/removed/renamed.
  const panels = useAppStore(useShallow((s) => {
    const ws = s.workspaces.find((w) => w.id === workspace.id)
    return ws?.panels ?? workspace.panels
  }))

  // Set of panel ids living on this workspace's canvases. Union of:
  //   (a) live canvas stores (covers the active workspace + any other
  //       workspace whose canvas was mounted earlier this session — those
  //       stores stay alive in the registry even after switching away), and
  //   (b) the workspace's persisted canvasNodes (cold-start fallback before
  //       any canvas has mounted in this session).
  // Used regardless of isSelected so active and non-active workspaces apply
  // the same classification rule.
  const liveCanvasPanelIds = useWorkspaceCanvasPanelIds(workspace.id)
  const canvasPanelIds = useMemo(() => {
    const ids = new Set<string>(liveCanvasPanelIds)
    for (const node of Object.values(workspace.canvasNodes ?? {})) {
      collectPanelIdsFromDockLayout(node.dockLayout, ids)
      if (node.panelId) ids.add(node.panelId)
    }
    return ids
  }, [liveCanvasPanelIds, workspace.canvasNodes])

  // Agent state in the status store is keyed by ptyId, but panel rows are
  // keyed by panelId. Translate via terminalRegistry so the awaiting/running
  // indicators on the workspace overview actually light up.
  const agentStateByPty = wsStatus?.agentState ?? {}
  const portsByPty = wsStatus?.listeningPorts ?? {}
  const agentStateByPanel = useMemo(() => {
    const out: Record<string, AgentState> = {}
    for (const [ptyId, state] of Object.entries(agentStateByPty)) {
      const pid = terminalRegistry.panelIdForPty(ptyId)
      if (pid) out[pid] = state
    }
    return out
  }, [agentStateByPty])
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

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
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
        label: (COLOR_NAMES[color] || color) + (color === workspace.color ? ' ✓' : ''),
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
        setRenameValue(workspace.name || workspace.rootPath.split('/').pop() || 'Workspace')
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
      case 'remove': app.removeWorkspace(workspace.id); break
    }
  }, [workspace.id, workspace.name, workspace.rootPath, workspace.color, workspace.panels, isSelected])

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

  const panelCount = Object.keys(panels).length

  // Sorted panel list grouped by type
  const panelList = useMemo(() => {
    const TYPE_ORDER: Record<string, number> = { canvas: 0, terminal: 1, editor: 2, browser: 3, git: 4, fileExplorer: 5, projectList: 6 }
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
    setRenameValue(workspace.name || workspace.rootPath?.split('/').pop() || 'Workspace')
    setIsRenaming(true)
  }, [workspace.name, workspace.rootPath])

  const handleTitleClick = useCallback((e: React.MouseEvent) => {
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
        className={`group flex items-center gap-2 h-8 px-2 rounded-md cursor-pointer text-muted hover:text-secondary hover:bg-hover transition-colors outline-none ${
          isContextActive ? 'ring-1 ring-strong' : ''
        } ${isSelected ? 'bg-surface-3' : ''}`}
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

  const lastSegment = workspace.rootPath.split('/').filter(Boolean).pop() || 'Workspace'
  const hasCustomName = workspace.name && workspace.name !== lastSegment && workspace.name !== 'Workspace'
  const displayTitle = hasCustomName ? workspace.name! : lastSegment

  const hasColor = !!workspace.color
  const accent = workspace.color || ''

  // Partition: canvas panels (parents), free panels (siblings to canvas).
  // A panel is a canvas child when EITHER the dock store says so OR a canvas
  // node references it. Canvas nodes are the source of truth for nodes that
  // were added directly to the canvas (vs. dragged from a dock zone).
  const isCanvasChild = (id: string) =>
    panelLocations?.[id]?.type === 'canvas' || canvasPanelIds.has(id)
  const canvasPanels = panelList.filter((p) => p.type === 'canvas')
  const canvasIds = new Set(canvasPanels.map((c) => c.id))
  const childrenByCanvas: Record<string, typeof panelList> = {}
  const orphanCanvasChildren: typeof panelList = []
  const freePanels: typeof panelList = []
  for (const p of panelList) {
    if (p.type === 'canvas') continue
    if (isCanvasChild(p.id)) {
      const loc = panelLocations?.[p.id]
      const cid = loc?.type === 'canvas' ? loc.canvasId : ''
      // Attach to a specific canvas if known; otherwise to the first canvas in
      // this workspace (canvasId is often empty for the implicit canvas).
      const target = cid && canvasIds.has(cid) ? cid : canvasPanels[0]?.id
      if (target) (childrenByCanvas[target] ||= []).push(p)
      else orphanCanvasChildren.push(p)
    } else {
      freePanels.push(p)
    }
  }

  const renderPanelRow = (p: typeof panelList[number], indent = false) => {
    if (p.type === 'terminal') {
      return (
        <TerminalPanelRow
          key={p.id}
          panel={p}
          indent={indent}
          agentState={agentStateByPanel[p.id]}
          hasPorts={(portsByPanel[p.id]?.length ?? 0) > 0}
          onClick={(e) => handlePanelClick(e, p.id)}
        />
      )
    }
    const Icon = PANEL_ICONS[p.type] ?? SquaresFour
    const label = p.title || p.filePath?.split('/').pop() || p.url || p.type
    const hasPorts = (portsByPanel[p.id]?.length ?? 0) > 0
    return (
      <button
        key={p.id}
        className={`group/panel flex items-center gap-1.5 h-7 pr-2 rounded text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none ${
          indent ? 'pl-10' : 'pl-7'
        }`}
        onClick={(e) => handlePanelClick(e, p.id)}
        title={p.filePath || p.url || label}
      >
        <Icon size={11} className="flex-shrink-0 opacity-60" />
        <span className="truncate min-w-0 flex-1">{label}</span>
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
        className={`group flex items-center gap-1 h-8 px-1.5 rounded-md cursor-pointer transition-colors outline-none ${
          isContextActive ? 'ring-1 ring-strong' : ''
        } ${
          isSelected
            ? 'bg-surface-3 text-primary'
            : 'text-secondary hover:text-primary hover:bg-hover'
        }`}
        style={hasColor ? {
          backgroundColor: isSelected ? `${accent}26` : `${accent}14`,
        } : undefined}
        onClick={onClick}
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
