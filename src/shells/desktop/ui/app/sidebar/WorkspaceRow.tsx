// One workspace in the sidebar: its row (name, connection state, panel count,
// menu) and, expanded, its panel tree from the document: canvases with their
// panels, top-level panels, the panels of its other windows, and its skills.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight as CaretRight, Ellipsis as DotsThree, Folder, FolderOpen, Link2, PanelsTopLeft, Server } from 'lucide-react'
import { Icon, Tooltip } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { useConnectionState, useWorkspaceRoot } from '../../client/connections'
import { useClientState, useDocument } from '../../client/document'
import { activeLayoutOf, activeTabOf, focusedLeafPanelId, panelRowLabel, switchLayout } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import { hostOf, placementOf, type PanelRecord } from '@workspace/document/contract'
import { InlineEditInput, canvasKey, toggleCollapsed, useTreeCollapseStore } from '../../workspace/files'
import { useWorktreeColor, worktreeTitleStyle } from '../../workspace/repository'
import { WorkspaceSkillsTree } from '../../workspace/skills'
import { AwaitingIndicator, RunningIndicator, agentInfoTitle, useAgentInfoByPanel, type AgentPanelInfo } from '../../services/agents'
import { clientApp } from '../app'
import { closePanels, closeWorkspace, renamePanel, revealPanel, selectWorkspace } from '../navigation'
import { panelIcon } from '../panels'
import { panelsWithPorts, terminalCwd } from '@services/terminal/client'
import { useTerminalStatuses } from '../state/statusStore'
import { useUIStore } from '../state/uiStore'
import { useWindowId } from '../state/windowContext'
import { WorkspaceToggle } from './connectionStatus'
import { PresenceAvatars } from './PresenceAvatars'
import { showMenu, type MenuItem } from './menu'
import { workspacePanelTree, type LayoutTree, type WindowTree } from './panelTree'
import { OTHER_WINDOWS_KEY, itemKey, layoutKey, layoutRows } from './sidebarDrag'
import { CANVAS_ORDER_KEY, GHOST_LOOK, beginDrag, groupLayoutOf, useDragOp, useDragSettled, useDragStore, type GapSpot } from '../../client/layout/drag'
import { closeLayout, showLayoutMenu, showPanelMenu, useLayoutRename } from '../../client/layout/windows'
import { DragFloat, type RowLook } from './GhostBlock'
import { takesCanvasDrop, useSidebarTree, type Float } from './useSidebarTree'

const isMiddleClick = (e: React.MouseEvent): boolean => e.button === 1

/** Where a group's rows start: the strip (at x 8 to 22 with its hit zone) ends before them. A
 *  member's content stays where a plain row's is, so only its chip moves. */
const GROUP_INDENT = 16

/** The strip of any other layout: the text color, dim. A color change only, so a hover never
 *  passes through a bright flash (an opacity jump over a color transition would). */
const DIM_STRIP = 'color-mix(in srgb, currentColor 8%, transparent)'

/** The background of the non-shown panels of the shown layout: the capsule's color, subdued. */
const MEMBER_BG = 'bg-[color-mix(in_srgb,var(--surface-2)_55%,transparent)]'

/** The strip of the shown or hovered layout: the accent the focused split's border has. */
const ACTIVE_ACCENT = 'color-mix(in srgb, var(--focus-blue, #3b82f6) 50%, transparent)'

/** The group's strip: as thick as its rounding is wide, on its left corners only (a pill's edge). */
const STRIP_THICKNESS = 4


interface WorkspaceRowProps {
  entry: WorkspaceEntry
  isOpen: boolean
  isSelected: boolean
  isMultiSelected?: boolean
  isExpanded: boolean
  onToggleExpand: () => void
  onClick: (e?: React.MouseEvent) => void
  /** Handles a right-click on a multi-selection; true when it did. */
  onBulkContextMenu?: (e: React.MouseEvent) => Promise<boolean>
}

interface RenameState {
  panelId: string
  value: string
  seed: string
}

export function WorkspaceRow({
  entry,
  isOpen,
  isSelected,
  isMultiSelected = false,
  isExpanded,
  onToggleExpand,
  onClick,
  onBulkContextMenu,
}: WorkspaceRowProps): JSX.Element {
  const workspaceId = entry.id
  const app = clientApp()
  const connection = app.connections.get(workspaceId)
  const windowId = useWindowId()
  const doc = useDocument(isOpen ? workspaceId : null, (d) => d)
  const rootPath = useWorkspaceRoot(isOpen ? workspaceId : null) || undefined
  const panelViews = useClientState(isOpen ? workspaceId : null, (s) => s.panelViews)
  const tree = useMemo(
    () => workspacePanelTree(doc, { windowId, rootPath, canvasOrder: (id) => panelViews[id]?.[CANVAS_ORDER_KEY] as string[] | undefined }),
    [doc, windowId, rootPath, panelViews],
  )
  const treeWindows = [tree.primary, ...tree.others]
  // The tree is a drop zone of the shared drag system; its rows start drags of it too.
  const sidebarTree = useSidebarTree(workspaceId, treeWindows)
  const view = sidebarTree.view
  const settled = useDragSettled()
  const { wasDragged } = useDragOp()
  // The drag of a panel or layout of this workspace, wherever it began (one object per drag).
  const dragSource = useDragStore((s) => (s.isDragging && s.source?.workspaceId === workspaceId ? s.source : null))
  const dragTitle = useDragStore((s) => s.panel?.title ?? '')
  const statuses = useTerminalStatuses(isOpen ? workspaceId : null)
  const ports = panelsWithPorts(statuses)
  const agents = useAgentInfoByPanel(isOpen ? workspaceId : null)
  const showSkills = useClientSetting('showSkillsInWorkspaceOverview')
  const skillsViewOpen = useUIStore((s) => s.overlay?.view === 'skills')
  const collapsed = useTreeCollapseStore((s) => s.collapsed)

  const [renamingWorkspace, setRenamingWorkspace] = useState<string | null>(null)
  const [rename, setRename] = useState<RenameState | null>(null)
  const layoutRename = useLayoutRename(workspaceId)
  const [menuOpen, setMenuOpen] = useState(false)
  // The group whose strip the cursor is on: its panels show as members, like the shown layout's.
  const [stripHover, setStripHover] = useState<string | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Focus and select once when renaming starts, not on every keystroke.
  const renamingOpen = renamingWorkspace !== null
  useEffect(() => {
    if (!renamingOpen) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [renamingOpen])

  const beginRename = useCallback(() => setRenamingWorkspace(entry.name), [entry.name])

  const submitWorkspaceRename = () => {
    const name = renamingWorkspace?.trim()
    if (name && name !== entry.name) void app.workspaces.rename(workspaceId, name)
    setRenamingWorkspace(null)
  }

  const allPanelIds = (): string[] => Object.keys(doc.panels)

  const handleContextMenu = async (e: React.MouseEvent) => {
    if (onBulkContextMenu && (await onBulkContextMenu(e))) return
    e.preventDefault()
    e.stopPropagation()
    const cwd = terminalCwd(statuses, isOpen ? focusedLeafPanelId(workspaceId) : null) ?? rootPath
    const items: MenuItem[] = [
      { id: 'select', label: 'Select Workspace', enabled: !isSelected },
      { id: 'rename', label: 'Rename Workspace' },
      { id: 'share', label: 'Share…', enabled: isOpen },
      { id: 'settings', label: 'Workspace Settings…', enabled: isOpen },
      { type: 'separator' },
      { id: 'copy-cwd', label: 'Copy Working Directory', enabled: !!cwd },
      { id: 'close-panels', label: 'Close All Panels', enabled: isOpen && tree.count > 0 },
      { type: 'separator' },
      { id: 'close', label: entry.kind === 'paired' ? 'Close Workspace…' : 'Close Workspace' },
    ]
    setMenuOpen(true)
    const id = await showMenu(items)
    setMenuOpen(false)
    switch (id) {
      case 'select': void selectWorkspace(workspaceId); break
      case 'rename': beginRename(); break
      case 'share':
        if (await selectWorkspace(workspaceId)) useUIStore.getState().openShare(workspaceId)
        break
      case 'settings':
        await selectWorkspace(workspaceId)
        useUIStore.getState().openSettings('runtime')
        break
      case 'copy-cwd': if (cwd) void clientUi().writeClipboard?.(cwd); break
      case 'close-panels': void closePanels(workspaceId, allPanelIds()); break
      case 'close': void closeWorkspace(workspaceId); break
    }
  }

  const beginPanelRename = (record: PanelRecord) => { const label = panelRowLabel(record); setRename({ panelId: record.id, value: label, seed: label }) }
  const handlePanelMenu = (e: React.MouseEvent, record: PanelRecord) =>
    showPanelMenu(e, workspaceId, record.id, { onRename: () => beginPanelRename(record) })

  const submitPanelRename = () => {
    if (!rename) return
    const title = rename.value.trim()
    // The seed may be a derived label; only an edit becomes the title.
    if (title && title !== rename.seed) renamePanel(workspaceId, rename.panelId, title)
    setRename(null)
  }

  const renderPanel = (record: PanelRecord, depth: number, active: boolean, member: boolean, indented: boolean, ghost: RowGhost | null = null) => (
    <WorkspacePanelRow
      key={record.id}
      ghost={ghost}
      record={record}
      depth={depth}
      active={active}
      member={member}
      indented={indented}
      agent={agents[record.id]}
      hasPorts={ports.has(record.id)}
      worktreeKey={Object.keys(doc.worktrees).length >= 2 && record.worktreeId ? doc.worktrees[record.worktreeId]?.color : undefined}
      onClick={(e) => { e.stopPropagation(); if (!wasDragged.current) void revealPanel(workspaceId, record.id) }}
      onPress={rename?.panelId !== record.id ? (e) => pressPanel(e, record.id) : undefined}
      onClose={() => void closePanels(workspaceId, [record.id])}
      onContextMenu={(e) => void handlePanelMenu(e, record)}
      rename={rename?.panelId === record.id ? {
        value: rename.value,
        onChange: (value) => setRename({ ...rename, value }),
        onSubmit: submitPanelRename,
        onCancel: () => setRename(null),
      } : null}
      onBeginRename={() => beginPanelRename(record)}
    />
  )

  const activeLayouts = useClientState(isOpen ? workspaceId : null, (s) => s.activeLayouts)
  const focusedPanelId = useClientState(isOpen ? workspaceId : null, (s) => s.focusedPanelId)
  const activeTabs = useClientState(isOpen ? workspaceId : null, (s) => s.activeTabs)

  /** A press on a panel row: a drag of its tab, from where it is placed. */
  const pressPanel = (e: React.MouseEvent<HTMLElement>, panelId: string) => {
    const placement = placementOf(doc, panelId)
    const host = placement ? hostOf(doc, placement.dock.layoutId) : undefined
    if (placement && host) beginDrag(e, { kind: 'dock-tab', workspaceId, dock: placement.dock, host, stackId: placement.stackId, panelId, from: 'sidebar' })
  }
  /** A press on a layout's handle: a drag of the whole layout, measured on its group. */
  const pressLayout = (e: React.MouseEvent<HTMLElement>, w: WindowTree, layout: LayoutTree) => {
    const panelId = layoutRows(layout)[0]?.record.id
    const box = e.currentTarget.closest('[data-layout-group]') ?? e.currentTarget
    if (panelId) beginDrag({ button: e.button, clientX: e.clientX, clientY: e.clientY, currentTarget: box }, { kind: 'layout', workspaceId, host: { windowId: w.windowId }, layoutId: layout.layoutId, panelId, from: 'sidebar' })
  }
  /** A layout is dragged as one ghost named like the window's strip names it: its name, else its position. */
  const layoutLook = (name: string) => ({
    label: name,
    icon: <PanelsTopLeft size={11} className="opacity-70" />,
  })

  // The row of the dragged panel (the group of the dragged layout) is the ghost, wherever the drag began: it
  // floats over the cursor while the tree takes the drop. A panel or layout with no row here floats as a look-alike.
  const own = dragSource?.from === 'sidebar' ? dragSource : null
  const rowOf = (id: string) => treeWindows.some((w) => w.layouts.some((l) => layoutRows(l).some((r) => r.record.id === id || (!collapsed.has(canvasKey(workspaceId, r.record.id)) && r.children.some((c) => c.id === id)))))
  const liftedPanel = dragSource?.origin.kind === 'dock-tab' && rowOf(dragSource.panelId) ? dragSource.panelId : null
  const draggedLayout = dragSource?.origin.kind === 'layout' ? dragSource.origin.layoutId : null
  const liftedLayout = draggedLayout && treeWindows.some((w) => w.layouts.some((l) => l.layoutId === draggedLayout)) ? draggedLayout : null
  /** A drag whose panel or layout has no row here floats in the tree as a look-alike. A
   *  layout is named as its window's strip names it (it may be another window's than the tree's). */
  const foreignLook = ((): RowLook | null => {
    if (liftedPanel || liftedLayout || !dragSource) return null
    // A layout, or a node of several panels (which leaves as its layout), carries the layout's name.
    const origin = dragSource.origin
    const moved = origin.kind === 'canvas-node' && origin.members?.length
    if (!moved && groupLayoutOf(doc, origin.kind, dragSource.panelId, origin.kind === 'layout' ? origin.layoutId : undefined)) return layoutLook(dragTitle)
    const record = doc.panels[dragSource.panelId]
    return record ? { label: panelRowLabel(record), icon: <Icon name={panelIcon(record.type)} size={11} style={{ opacity: 0.6 }} /> } : null
  })()
  /** A dragged tab (from the tree, a strip or a split) that can live on a canvas: every canvas shows its container. */
  const canvasDrop = !!dragSource && takesCanvasDrop(dragSource, doc.panels[dragSource.panelId]?.type)
  const canvasTarget = view?.target.kind === 'canvas-slot' ? view.target.canvasPanelId : null
  /** A lifted panel row is the ghost itself, restyled: floating over the cursor while the tree takes the drop. When the drag is off-zone, no ghost. */
  const rowGhost = (id: string): RowGhost | null => (liftedPanel === id && view ? { rect: view.float } : null)
  /** The margin that opens the gap on the row at `side` of the gap spot. */
  const gapStyle = (here: (spot: GapSpot) => boolean, side: 'Top' | 'Bottom'): React.CSSProperties => {
    const transition = settled ? 'margin 140ms ease' : undefined
    return view?.gap && here(view.gap) ? { [`margin${side}`]: view.size, transition } : { transition }
  }

  /** The panel a layout shows: the focused one when it is in it, else the shown tab of its first stack. */
  const shownPanelOf = (layout: LayoutTree): string | undefined => {
    const rows = layoutRows(layout)
    if (focusedPanelId && rows.some((row) => row.record.id === focusedPanelId)) return focusedPanelId
    const first = layout.stacks[0]
    return first && first.items.length > 0 ? activeTabOf(activeTabs, { kind: 'stack', id: first.stackId, panels: first.items.map((item) => item.record.id) }) : undefined
  }

  /** A layout with several panels is a group: its rows are regular rows, told apart as
   *  members by a thick strip floating at their left (the handle of the layout: click shows
   *  it, drag moves it, right-click opens its menu) and by their background while the layout
   *  is shown. A layout with one panel is a plain row; an empty one draws nothing. */
  const renderWindow = (w: WindowTree) => {
    const active = activeLayoutOf(doc, activeLayouts, { windowId: w.windowId })
    return <React.Fragment key={w.windowId}>{w.layouts.map((layout) => renderLayout(w, layout, layout.layoutId === active))}</React.Fragment>
  }

  const renderLayout = (w: WindowTree, layout: LayoutTree, layoutActive: boolean) => {
    const rows = layoutRows(layout)
    if (rows.length === 0) return null
    // A lifted layout leaves the list: under the cursor while the tree takes the drop, and off the tree the
    // zone that owns the drop shows the ghost (a dock's chip, a canvas's node), so nothing stays in its spot.
    if (liftedLayout === layout.layoutId && (view || own)) return null
    const shown = shownPanelOf(layout)
    const style: React.CSSProperties = {
      ...gapStyle((spot) => spot.at === 'item' && spot.layoutId === layout.layoutId, 'Top'),
      ...gapStyle((spot) => spot.at === 'row-end' && spot.layoutId === layout.layoutId, 'Bottom'),
    }
    const member = layout.group && (layoutActive || stripHover === layout.layoutId)
    const content = rows.map((row) => renderRow(row, layoutActive && row.record.id === shown, member, layout.group))
    if (!layout.group) {
      return <div key={layout.layoutId} data-sb-key={layoutKey(w.windowId, layout.layoutId)} style={style}>{content}</div>
    }
    return (
      <div key={layout.layoutId} data-layout-group={layout.layoutId} data-sb-key={layoutKey(w.windowId, layout.layoutId)} className="relative" style={style}>
        <div
          role="button"
          aria-label="Layout"
          data-layout-gutter={layout.layoutId}
          className="group/strip absolute z-10 cursor-grab"
          style={{ left: 8, top: 4, bottom: 4, width: 14 }}
          onPointerEnter={() => setStripHover(layout.layoutId)}
          onPointerLeave={() => setStripHover(null)}
          onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault(); else pressLayout(e, w, layout) }}
          onAuxClick={(e) => {
            if (!isMiddleClick(e) || w.layouts.length < 2) return
            e.preventDefault()
            e.stopPropagation()
            void closeLayout(workspaceId, layout.layoutId)
          }}
          onClick={(e) => { e.stopPropagation(); if (!wasDragged.current && e.detail < 2) switchLayout(workspaceId, { windowId: w.windowId }, layout.layoutId) }}
          onDoubleClick={(e) => { e.stopPropagation(); layoutRename.begin({ id: layout.layoutId, name: layout.name }) }}
          onContextMenu={(e) => void showLayoutMenu(e, workspaceId, layout.layoutId, { onRename: () => layoutRename.begin({ id: layout.layoutId, name: layout.name }), closable: w.layouts.length > 1 })}
        >
          {/* Rounded by clipping, not by a border radius: a radius as wide as the strip paints stray pixels just outside its left edge. */}
          <span
            aria-hidden
            data-layout-strip
            className="pointer-events-none absolute inset-y-0 left-1 transition-colors"
            style={{
              width: STRIP_THICKNESS,
              clipPath: `inset(0 round ${STRIP_THICKNESS}px 0 0 ${STRIP_THICKNESS}px)`,
              backgroundColor: layoutActive || stripHover === layout.layoutId ? ACTIVE_ACCENT : DIM_STRIP,
            }}
          />
        </div>
        {layoutRename.renameId === layout.layoutId && (
          <div className="mx-1.5 my-0.5 h-7 flex items-center" style={{ paddingLeft: 28 }}>
            {layoutRename.input(layout.layoutId, 'flex-1 min-w-0 text-[13px] px-1')}
          </div>
        )}
        {content}
      </div>
    )
  }

  const renderRow = (
    { record, children, stackId }: ReturnType<typeof layoutRows>[number],
    active: boolean,
    member: boolean,
    indented: boolean,
  ) => {
    const ghost = rowGhost(record.id)
    const isCollapsed = collapsed.has(canvasKey(workspaceId, record.id))
    // A lifted canvas takes its children with it; a lifted child stays in the list, as the ghost.
    const kids = ghost ? [] : children
    const container = record.canvasId !== undefined && canvasDrop
    const endGap = view?.gap?.at === 'canvas-end' && view.gap.canvasPanelId === record.id
    return (
      <div
        key={record.id}
        data-sb-key={itemKey(record.id)}
        data-sb-stack={stackId}
        // A block formatting context: the row's margins stay inside it, so rows touch and measure as they look.
        className="relative flow-root"
        style={{
          ...(indented ? { paddingLeft: GROUP_INDENT } : null),
          ...gapStyle((spot) => spot.at === 'member' && spot.panelId === record.id, 'Top'),
          ...gapStyle((spot) => spot.at === 'group-end' && spot.panelId === record.id, 'Bottom'),
        }}
      >
        {record.canvasId ? (
          <>
            {container && (
              // The canvas's container, drawn while a drag could drop into it: its bottom edge is a slot of its own.
              <div
                aria-hidden
                data-canvas-container={record.id}
                className="pointer-events-none absolute inset-y-0.5 rounded-lg border transition-colors"
                style={{ left: 6 + (indented ? GROUP_INDENT : 0), right: 6, borderColor: canvasTarget === record.id ? ACTIVE_ACCENT : DIM_STRIP }}
              />
            )}
            <CanvasRow
              record={record}
              active={active}
              member={member}
              indented={indented}
              ghost={ghost}
              hasChildren={children.length > 0}
              collapsed={isCollapsed}
              onToggle={() => toggleCollapsed(canvasKey(workspaceId, record.id))}
              onClick={(e) => { e.stopPropagation(); if (!wasDragged.current) void revealPanel(workspaceId, record.id) }}
              onPress={(e) => pressPanel(e, record.id)}
              onContextMenu={(e) => void handlePanelMenu(e, record)}
            />
            {!isCollapsed && kids.map((child) => (
              <div
                key={child.id}
                data-sb-key={itemKey(child.id)}
                className="flow-root"
                style={gapStyle((spot) => spot.at === 'canvas-child' && spot.canvasPanelId === record.id && spot.panelId === child.id, 'Top')}
              >
                {renderPanel(child, 1, false, false, indented, rowGhost(child.id))}
              </div>
            ))}
            {container && <div aria-hidden data-canvas-end style={{ height: endGap ? view!.size : 0, transition: settled ? 'height 140ms ease' : undefined }} />}
          </>
        ) : renderPanel(record, 0, active, member, indented, ghost)}
      </div>
    )
  }

  const displayTitle = entry.name
  const FolderIcon = isExpanded ? FolderOpen : Folder
  // Only a connected workspace shows its tree: the document mirror outlives a
  // dropped connection (it resumes from it), the sidebar does not show it.
  const connected = useConnectionState(isOpen ? connection : undefined).kind === 'connected'
  const canExpand = connected && tree.count > 0

  return (
    <div onContextMenu={(e) => void handleContextMenu(e)} data-workspace-id={workspaceId}>
      <div
        className={`group mx-1.5 my-0.5 rounded-lg flex items-center gap-1 h-7 px-1.5 cursor-pointer transition-colors outline-none ${
          menuOpen ? 'ring-1 ring-strong' : ''
        } ${
          isMultiSelected
            ? 'bg-surface-6 text-primary ring-1 ring-strong'
            : isSelected ? 'bg-surface-6 text-primary' : 'text-secondary hover:text-primary hover:bg-hover'
        }`}
        onClick={(e) => onClick(e)}
        aria-selected={isSelected}
        role="treeitem"
        aria-expanded={canExpand ? isExpanded : undefined}
      >
        <WorkspaceToggle connection={isOpen ? connection : undefined} canExpand={canExpand} expanded={isExpanded} onToggle={onToggleExpand} />
        {entry.kind === 'paired'
          ? <Link2 size={14} className="flex-shrink-0 opacity-90" />
          : entry.kind === 'machine'
            ? <Server size={14} className="flex-shrink-0 opacity-90" />
            : <FolderIcon size={14} className="flex-shrink-0 opacity-90" />}
        {renamingWorkspace !== null ? (
          <InlineEditInput
            ref={renameInputRef}
            className="flex-1 min-w-0 text-[14px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
            value={renamingWorkspace}
            onChange={setRenamingWorkspace}
            onSubmit={submitWorkspaceRename}
            onCancel={() => setRenamingWorkspace(null)}
          />
        ) : (
          <span
            className={`flex-1 min-w-0 text-[14px] truncate ${isOpen ? '' : 'opacity-70'} ${isSelected ? 'cursor-text' : ''}`}
            title={isSelected ? 'Rename workspace' : rootPath ?? displayTitle}
            onClick={(e) => {
              if (e.shiftKey || e.metaKey || e.ctrlKey || !isSelected) return
              e.stopPropagation()
              beginRename()
            }}
            onDoubleClick={(e) => { e.stopPropagation(); beginRename() }}
          >
            {displayTitle}
          </span>
        )}
        {isOpen && <PresenceAvatars workspaceId={entry.id} />}
        {canExpand && !isExpanded && (
          <span className="flex-shrink-0 text-[10px] text-secondary font-semibold opacity-80 group-hover:opacity-100 transition-opacity">
            {tree.count}
          </span>
        )}
        <Tooltip label="More actions">
          <button
            className="flex-shrink-0 w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-80 hover:!opacity-100 text-secondary hover:text-primary transition-opacity focus:outline-none"
            onClick={(e) => { e.stopPropagation(); void handleContextMenu(e) }}
            aria-label="More actions"
          >
            <DotsThree size={14} />
          </button>
        </Tooltip>
      </div>
      {isExpanded && canExpand && (
        <div ref={sidebarTree.containerRef} className={`flex flex-col ${dragSource ? 'select-none' : ''}`} role="group">
          {renderWindow(tree.primary)}
          {tree.others.length > 0 && (
            <>
              <div data-sb-key={OTHER_WINDOWS_KEY} className="flex items-center gap-1.5 h-6 pl-7 pr-2 text-[11px] text-muted opacity-70">
                <span className="truncate">Other windows</span>
              </div>
              {tree.others.map(renderWindow)}
            </>
          )}
          {view && foreignLook && <DragFloat look={foreignLook} float={view.float} />}
          {view && liftedLayout && treeWindows.flatMap((w) => w.layouts.filter((l) => l.layoutId === liftedLayout).map((l) => <DragFloat key={l.layoutId} look={layoutLook(l.name)} float={view.float} />))}
          <WorkspaceSkillsTree
            workspaceId={workspaceId}
            enabled={showSkills}
            skillsViewOpen={skillsViewOpen}
            onOpenSkills={() => {
              void selectWorkspace(workspaceId).then((ok) => { if (ok) useUIStore.getState().openOverlay({ view: 'skills' }) })
            }}
          />
        </div>
      )}
    </div>
  )
}

interface PanelRowRename {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
}

/** A lifted row, drawn as the ghost: `rect` is where it floats (fixed over the cursor), null in its own place. */
interface RowGhost {
  rect: Float | null
}

/** The restyle that turns a row into its ghost: the shared look, and out of the flow while it floats. */
function ghostStyle(ghost: RowGhost): React.CSSProperties {
  return {
    ...GHOST_LOOK,
    ...(ghost.rect ? { position: 'fixed', margin: 0, zIndex: 10000, pointerEvents: 'none', left: ghost.rect.left, top: ghost.rect.top, width: ghost.rect.width, height: ghost.rect.height } : null),
  }
}

const ghostAttrs = (ghost: RowGhost | null) => (ghost ? (ghost.rect ? { 'data-sidebar-drag-float': '' } : { 'data-sidebar-drag-ghost': '' }) : {})

interface WorkspacePanelRowProps {
  record: PanelRecord
  /** 0 for a tab of a stack, 1 for a panel on a canvas. */
  depth: number
  /** The panel its layout shows. */
  active?: boolean
  /** A panel of a group while the group shows: a faint background. */
  member?: boolean
  /** A panel of a group: its chip starts past the group's strip. */
  indented?: boolean
  /** Lifted by a drag: this row, restyled as the ghost. */
  ghost?: RowGhost | null
  agent?: AgentPanelInfo
  hasPorts?: boolean
  /** The panel's worktree palette key, when worktrees are told apart. */
  worktreeKey?: string
  onClick: (e: React.MouseEvent) => void
  /** A press that may start a drag of the row. */
  onPress?: (e: React.MouseEvent<HTMLElement>) => void
  /** Middle-click closes. */
  onClose?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  rename?: PanelRowRename | null
  onBeginRename?: () => void
}

export function WorkspacePanelRow({
  record,
  depth,
  active = false,
  member = false,
  indented = false,
  ghost = null,
  agent,
  hasPorts = false,
  worktreeKey,
  onClick,
  onPress,
  onClose,
  onContextMenu,
  rename,
  onBeginRename,
}: WorkspacePanelRowProps): JSX.Element {
  const label = agentInfoTitle(panelRowLabel(record), agent)
  const worktreeColor = useWorktreeColor(worktreeKey)
  const running = agent?.status === 'running'
  const awaiting = agent?.status === 'waitingForInput'
  const inputRef = useRef<HTMLInputElement>(null)
  const renaming = !!rename
  useEffect(() => {
    if (renaming) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [renaming])

  return (
    <button
      className={`group/panel mx-1.5 my-0.5 w-[calc(100%-12px)] rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] hover:bg-hover text-left min-w-0 focus:outline-none ${
        // As in the window's strip: the shown layout's group has the capsule color, its shown
        // panel the stronger one, and a plain row's shown state is the tab's.
        active ? `${indented ? 'bg-hover' : 'bg-surface-2'} text-primary` : `${member ? MEMBER_BG : ''} ${awaiting ? 'text-primary' : member ? 'text-secondary hover:text-primary' : 'text-muted hover:text-primary'}`}`}
      style={{ paddingLeft: (depth > 0 ? 40 : 28) - (indented ? GROUP_INDENT : 0), ...(ghost ? ghostStyle(ghost) : null) }}
      {...ghostAttrs(ghost)}
      onClick={(e) => { if (e.detail < 2) onClick?.(e) }}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault(); else onPress?.(e) }}
      onDoubleClick={onBeginRename}
      onAuxClick={(e) => {
        if (isMiddleClick(e) && onClose) {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
      title={label}
      data-panel-id={record.id}
    >
      {agent?.logo ? (
        <img src={agent.logo} alt="" width={11} height={11} draggable={false} className="flex-shrink-0" style={{ width: 11, height: 11, objectFit: 'contain', opacity: 0.95 }} />
      ) : (
        <Icon name={panelIcon(record.type)} size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
      )}
      {rename ? (
        <InlineEditInput
          ref={inputRef}
          className="flex-1 min-w-0 text-[13px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
          value={rename.value}
          onChange={rename.onChange}
          onSubmit={rename.onSubmit}
          onCancel={rename.onCancel}
        />
      ) : (
        <span
          className="min-w-0 flex-1 truncate"
          style={worktreeTitleStyle(worktreeColor)}
        >
          {label}
        </span>
      )}
      {awaiting ? (
        <AwaitingIndicator />
      ) : running ? (
        <RunningIndicator />
      ) : hasPorts ? (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" aria-label="listening on a port" />
      ) : null}
    </button>
  )
}

function CanvasRow({ record, active = false, member = false, indented = false, ghost = null, hasChildren, collapsed, onToggle, onClick, onPress, onContextMenu }: {
  record: PanelRecord
  active?: boolean
  member?: boolean
  indented?: boolean
  ghost?: RowGhost | null
  hasChildren: boolean
  collapsed: boolean
  onToggle: () => void
  onClick: (e: React.MouseEvent) => void
  onPress?: (e: React.MouseEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const label = panelRowLabel(record)
  return (
    <div
      role="button"
      tabIndex={0}
      className={`group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] hover:text-primary hover:bg-hover text-left min-w-0 cursor-pointer focus:outline-none ${
        active ? `${indented ? 'bg-hover' : 'bg-surface-2'} text-primary` : `${member ? `${MEMBER_BG} text-secondary` : 'text-muted'}`}`}
      style={{ paddingLeft: indented ? 0 : 12, ...(ghost ? ghostStyle(ghost) : null) }}
      {...ghostAttrs(ghost)}
      onClick={onClick}
      onMouseDown={onPress}
      onContextMenu={onContextMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick(e as unknown as React.MouseEvent)
        }
      }}
      title={label}
      data-panel-id={record.id}
    >
      {hasChildren ? (
        <button
          type="button"
          className="flex-shrink-0 flex items-center justify-center w-[10px] text-muted hover:text-primary focus:outline-none"
          onClick={(e) => { e.stopPropagation(); onToggle() }}
          aria-label={collapsed ? 'Expand canvas' : 'Collapse canvas'}
        >
          <CaretRight size={10} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        </button>
      ) : (
        <span className="flex-shrink-0 w-[10px]" />
      )}
      <Icon name={panelIcon(record.type)} size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
      <span className="truncate min-w-0 flex-1">{label}</span>
    </div>
  )
}
