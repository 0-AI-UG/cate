// One workspace in the sidebar: its row (name, connection state, panel count,
// menu) and, expanded, its panel tree from the document: canvases with their
// panels, top-level panels, the panels of its other windows, and its skills.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight as CaretRight, Ellipsis as DotsThree, Folder, FolderOpen, Link2, PanelsTopLeft } from 'lucide-react'
import { Icon, Tooltip } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { useConnectionState, useWorkspaceRoot } from '../../client/connections'
import { useClientState, useDocument } from '../../client/document'
import { activeLayoutOf, focusedLeafPanelId, panelRowLabel, switchLayout } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import type { PanelRecord } from '@workspace/document/contract'
import { InlineEditInput, canvasKey, toggleCollapsed, useTreeCollapseStore } from '../../workspace/files'
import { useWorktreeColor, worktreeTitleStyle } from '../../workspace/repository'
import { WorkspaceSkillsTree } from '../../workspace/skills'
import { AwaitingIndicator, RunningIndicator, agentInfoTitle, useAgentInfoByPanel, type AgentPanelInfo } from '../../services/agents'
import { clientApp } from '../app'
import { closePanels, closeWorkspace, detachPanel, renamePanel, revealPanel, selectWorkspace } from '../navigation'
import { panelIcon } from '../panels'
import { panelsWithPorts, terminalCwd, useTerminalStatuses } from '../state/statusStore'
import { useUIStore } from '../state/uiStore'
import { useWindowId } from '../state/windowContext'
import { WorkspaceToggle } from './connectionStatus'
import { showMenu, type MenuItem } from './menu'
import { DropGhostChip } from '../../client/layout/dock'
import { CANVAS_ORDER_KEY, workspacePanelTree, type LayoutTree, type StackGroup, type WindowTree } from './panelTree'
import { LAYOUT_INSET, headingKey, layoutKey, itemKey, type CanvasSlot } from './sidebarDrag'
import { DragFloat, useSidebarDrag } from './useSidebarDrag'

const isMiddleClick = (e: React.MouseEvent): boolean => e.button === 1

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
  const sidebarDrag = useSidebarDrag(workspaceId, [tree.primary, ...tree.others])
  const statuses = useTerminalStatuses(isOpen ? workspaceId : null)
  const ports = panelsWithPorts(statuses)
  const agents = useAgentInfoByPanel(isOpen ? workspaceId : null)
  const showSkills = useClientSetting('showSkillsInWorkspaceOverview')
  const skillsViewOpen = useUIStore((s) => s.overlay?.view === 'skills')
  const collapsed = useTreeCollapseStore((s) => s.collapsed)

  const [renamingWorkspace, setRenamingWorkspace] = useState<string | null>(null)
  const [rename, setRename] = useState<RenameState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
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
      { id: 'settings', label: 'Workspace Settings…', enabled: isOpen },
      { type: 'separator' },
      { id: 'copy-cwd', label: 'Copy Working Directory', enabled: !!cwd },
      { id: 'close-panels', label: 'Close All Panels', enabled: isOpen && tree.count > 0 },
      { type: 'separator' },
      { id: 'close', label: 'Close Workspace', enabled: isOpen },
      entry.kind === 'local'
        ? { id: 'remove', label: 'Remove from Recents' }
        : { id: 'forget', label: 'Forget Workspace…' },
    ]
    setMenuOpen(true)
    const id = await showMenu(items)
    setMenuOpen(false)
    switch (id) {
      case 'select': void selectWorkspace(workspaceId); break
      case 'rename': beginRename(); break
      case 'settings':
        await selectWorkspace(workspaceId)
        useUIStore.getState().openSettings('runtime')
        break
      case 'copy-cwd': if (cwd) void clientUi().writeClipboard?.(cwd); break
      case 'close-panels': void closePanels(workspaceId, allPanelIds()); break
      case 'close': closeWorkspace(workspaceId); break
      case 'remove': void app.workspaces.removeRecent(workspaceId); break
      case 'forget': {
        const ok = await clientUi().confirm(`Forget "${entry.name}"? This device can open it again only after pairing with a new code.`)
        if (ok) await app.workspaces.forget(workspaceId).catch((err) => clientUi().showError(errorMessage(err, 'Could not forget the workspace.')))
        break
      }
    }
  }

  const handlePanelMenu = async (e: React.MouseEvent, record: PanelRecord) => {
    e.preventDefault()
    e.stopPropagation()
    const label = panelRowLabel(record)
    const id = await showMenu([
      { id: 'rename', label: 'Rename' },
      { id: 'move-window', label: 'Move into New Window' },
      { type: 'separator' },
      { id: 'close', label: 'Close' },
    ])
    if (id === 'rename') setRename({ panelId: record.id, value: label, seed: label })
    else if (id === 'move-window') detachPanel(workspaceId, record.id)
    else if (id === 'close') void closePanels(workspaceId, [record.id])
  }

  const submitPanelRename = () => {
    if (!rename) return
    const title = rename.value.trim()
    // The seed may be a derived label; only an edit becomes the title.
    if (title && title !== rename.seed) renamePanel(workspaceId, rename.panelId, title)
    setRename(null)
  }

  const renderPanel = (record: PanelRecord, depth: number, inset: number) => (
    <WorkspacePanelRow
      key={record.id}
      record={record}
      depth={depth}
      inset={inset}
      agent={agents[record.id]}
      hasPorts={ports.has(record.id)}
      worktreeKey={Object.keys(doc.worktrees).length >= 2 && record.worktreeId ? doc.worktrees[record.worktreeId]?.color : undefined}
      onClick={(e) => { e.stopPropagation(); if (!sidebarDrag.consumeClick()) void revealPanel(workspaceId, record.id) }}
      onPointerDown={rename?.panelId !== record.id ? (e) => sidebarDrag.begin(e, { kind: 'panel', panelId: record.id }, rowLook(record)) : undefined}
      onClose={() => void closePanels(workspaceId, [record.id])}
      onContextMenu={(e) => void handlePanelMenu(e, record)}
      rename={rename?.panelId === record.id ? {
        value: rename.value,
        onChange: (value) => setRename({ ...rename, value }),
        onSubmit: submitPanelRename,
        onCancel: () => setRename(null),
      } : null}
      onBeginRename={() => { const label = panelRowLabel(record); setRename({ panelId: record.id, value: label, seed: label }) }}
    />
  )

  const activeLayouts = useClientState(isOpen ? workspaceId : null, (s) => s.activeLayouts)

  const rowLook = (record: PanelRecord) => ({
    label: panelRowLabel(record),
    icon: <Icon name={panelIcon(record.type)} size={11} style={{ opacity: 0.6 }} />,
  })
  const layoutLook = (label: string) => ({ label, icon: <PanelsTopLeft size={11} className="opacity-70" /> })

  /** The dashed row a drag leaves where its drop would land. */
  const ghostRow = (look: { label: string; icon: React.ReactNode }, inset: number) => (
    // Spans the row like a row does; only its content is indented.
    <div key="__ghost__" className="mx-1.5 my-0.5 flex h-7 items-center [&>*]:w-full" data-sidebar-drag-ghost>
      <DropGhostChip compact start icon={look.icon} style={{ paddingLeft: inset - 1, minWidth: 0 }}>{look.label}</DropGhostChip>
    </div>
  )

  /** Every window lists its layouts in switcher order; with several, each sits
   *  under a heading that shows it and its rows are indented one icon in. A
   *  layout's stacks (split sections) are spaced apart. */
  const renderWindow = (w: WindowTree) => {
    const multi = w.layouts.length > 1
    const lifted = sidebarDrag.drag?.kind === 'layout' && sidebarDrag.drag.windowId === w.windowId ? sidebarDrag.drag : null
    const shown = w.layouts.filter((l) => l.layoutId !== lifted?.layoutId)
    const active = activeLayoutOf(doc, activeLayouts, w.windowId)
    const layoutGhost = lifted?.slot ? ghostRow(lifted.look, 12) : null
    return (
      <React.Fragment key={w.windowId}>
        {shown.map((layout, shownIndex) => (
          <React.Fragment key={layout.layoutId}>
            {lifted?.slot?.index === shownIndex && layoutGhost}
            <div data-sb-key={layoutKey(w.windowId, layout.layoutId)}>
              {multi && renderHeading(w, layout, w.layouts.indexOf(layout), layout.layoutId === active)}
              {renderLayout(w, layout, multi ? LAYOUT_INSET : 0)}
            </div>
          </React.Fragment>
        ))}
        {lifted?.slot && lifted.slot.index >= shown.length && layoutGhost}
      </React.Fragment>
    )
  }

  const renderHeading = (w: WindowTree, layout: LayoutTree, index: number, isActive: boolean) => {
    const label = layout.name || `Layout ${index + 1}`
    return (
      <button
        type="button"
        data-layout-heading={layout.layoutId}
        data-sb-key={headingKey(w.windowId, layout.layoutId)}
        className={`mx-1.5 my-0.5 flex h-6 w-[calc(100%-12px)] items-center gap-1.5 rounded-lg pl-3 pr-2 text-left text-[11px] hover:bg-hover focus:outline-none ${
          isActive ? 'text-secondary' : 'text-muted'}`}
        onPointerDown={(e) => sidebarDrag.begin(e, { kind: 'layout', windowId: w.windowId, layoutId: layout.layoutId }, layoutLook(label))}
        onClick={(e) => { e.stopPropagation(); if (!sidebarDrag.consumeClick()) switchLayout(workspaceId, w.windowId, layout.layoutId) }}
      >
        <PanelsTopLeft size={11} className="shrink-0 opacity-70" />
        <span className="truncate">{label}</span>
      </button>
    )
  }

  const renderLayout = (w: WindowTree, layout: LayoutTree, inset: number) => {
    const dragged = sidebarDrag.drag?.kind === 'panel' ? sidebarDrag.drag : null
    const slot = dragged?.slot?.windowId === w.windowId && dragged.slot.layoutId === layout.layoutId ? dragged.slot : null
    const stackSlot = slot && !('canvasId' in slot) ? slot : null
    const canvasSlot = slot && 'canvasId' in slot ? slot : null
    const ghost = dragged && stackSlot ? ghostRow(dragged.look, inset + 28) : null
    const childGhost = dragged && canvasSlot ? ghostRow(dragged.look, inset + 40) : null
    return (
      <>
        {layout.stacks.map((stack, stackIndex) => renderStack(stack, stackIndex, inset, dragged?.panelId, stackSlot?.stackId === stack.stackId ? stackSlot.after : undefined, ghost, canvasSlot, childGhost))}
        {layout.stacks.length === 0 && stackSlot && ghost}
      </>
    )
  }

  /** `ghostAfter`: the panel the ghost follows (null: first), undefined: no ghost here. */
  const renderStack = (stack: StackGroup, stackIndex: number, inset: number, liftedId: string | undefined, ghostAfter: string | null | undefined, ghost: React.ReactNode, canvasSlot: CanvasSlot | null, childGhost: React.ReactNode) => {
    const items = stack.items.filter((item) => item.record.id !== liftedId)
    if (items.length === 0 && ghostAfter === undefined) return null
    return (
      <div key={stack.stackId} data-sb-stack={stack.stackId} className={stackIndex > 0 ? 'relative mt-2' : undefined}>
        {stackIndex > 0 && sidebarDrag.drag?.kind === 'panel' && (
          // Splits are told apart by a hairline in the middle of their gap, only while a row is dragged.
          <div aria-hidden data-split-divider className="pointer-events-none absolute -top-[5px] right-3 h-[2px] rounded-full bg-[var(--border-strong)]" style={{ left: inset + 18 }} />
        )}
        {ghostAfter === null && ghost}
        {items.map(({ record, children }) => {
          const isCollapsed = collapsed.has(canvasKey(workspaceId, record.id))
          return (
            <React.Fragment key={record.id}>
              <div data-sb-key={itemKey(record.id)}>
                {record.canvasId ? (
                  <>
                    <CanvasRow
                      record={record}
                      inset={inset}
                      hasChildren={children.length > 0}
                      collapsed={isCollapsed}
                      onToggle={() => toggleCollapsed(canvasKey(workspaceId, record.id))}
                      onClick={(e) => { e.stopPropagation(); if (!sidebarDrag.consumeClick()) void revealPanel(workspaceId, record.id) }}
                      onPointerDown={(e) => sidebarDrag.begin(e, { kind: 'panel', panelId: record.id }, rowLook(record))}
                      onContextMenu={(e) => void handlePanelMenu(e, record)}
                    />
                    {canvasSlot?.canvasPanelId === record.id ? (
                      // The ghost is a node the drop adds; a collapsed canvas shows it right under its row.
                      <>
                        {(isCollapsed || canvasSlot.afterChild === null) && childGhost}
                        {!isCollapsed && children.filter((c) => c.id !== liftedId).map((child) => (
                          <React.Fragment key={child.id}>
                            <div data-sb-key={itemKey(child.id)}>{renderPanel(child, 1, inset)}</div>
                            {canvasSlot.afterChild === child.id && childGhost}
                          </React.Fragment>
                        ))}
                      </>
                    ) : !isCollapsed && children.filter((c) => c.id !== liftedId).map((child) => (
                      <div key={child.id} data-sb-key={itemKey(child.id)}>{renderPanel(child, 1, inset)}</div>
                    ))}
                  </>
                ) : renderPanel(record, 0, inset)}
              </div>
              {ghostAfter === record.id && ghost}
            </React.Fragment>
          )
        })}
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
        <div ref={sidebarDrag.containerRef} className={`flex flex-col ${sidebarDrag.drag ? 'select-none' : ''}`} role="group">
          {renderWindow(tree.primary)}
          {tree.others.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 h-6 pl-7 pr-2 text-[11px] uppercase tracking-wide text-muted opacity-70">
                <span className="truncate">Other windows</span>
              </div>
              {tree.others.map(renderWindow)}
            </>
          )}
          {sidebarDrag.drag && <DragFloat look={sidebarDrag.drag.look} float={sidebarDrag.drag.float} />}
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

interface WorkspacePanelRowProps {
  record: PanelRecord
  /** 0 for a tab of a stack, 1 for a panel on a canvas. */
  depth: number
  /** Extra left padding in px (the rows of a layout under its heading). */
  inset?: number
  agent?: AgentPanelInfo
  hasPorts?: boolean
  /** The panel's worktree palette key, when worktrees are told apart. */
  worktreeKey?: string
  onClick: (e: React.MouseEvent) => void
  /** Starts a drag of the row. */
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void
  /** Middle-click closes. */
  onClose?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  rename?: PanelRowRename | null
  onBeginRename?: () => void
}

export function WorkspacePanelRow({
  record,
  depth,
  inset = 0,
  agent,
  hasPorts = false,
  worktreeKey,
  onClick,
  onPointerDown,
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
        awaiting ? 'text-primary' : 'text-muted hover:text-primary'}`}
      style={{ paddingLeft: (depth > 0 ? 40 : 28) + inset }}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onMouseDown={(e) => { if (isMiddleClick(e)) e.preventDefault() }}
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
          onDoubleClick={(e) => { e.stopPropagation(); onBeginRename?.() }}
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

function CanvasRow({ record, inset = 0, hasChildren, collapsed, onToggle, onClick, onPointerDown, onContextMenu }: {
  record: PanelRecord
  inset?: number
  hasChildren: boolean
  collapsed: boolean
  onToggle: () => void
  onClick: (e: React.MouseEvent) => void
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const label = panelRowLabel(record)
  return (
    <div
      role="button"
      tabIndex={0}
      className="group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 cursor-pointer focus:outline-none"
      style={{ paddingLeft: 12 + inset }}
      onClick={onClick}
      onPointerDown={onPointerDown}
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
