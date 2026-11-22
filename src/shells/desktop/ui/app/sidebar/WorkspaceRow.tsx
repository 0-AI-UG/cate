// One workspace in the sidebar: its row (name, connection state, panel count,
// menu) and, expanded, its panel tree from the document: canvases with their
// panels, top-level panels, the panels of its other windows, and its skills.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight as CaretRight, Copy, Folder, Ellipsis as DotsThree, Globe, LogOut, PanelsTopLeft, Pencil, Puzzle, Server, Settings2, UserPlus } from 'lucide-react'
import { Tooltip } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { useConnectionState, useWorkspaceRoot } from '../../client/connections'
import { useDocument } from '../../client/document'
import { focusedLeafPanelId, panelRowLabel } from '@client/host'
import { machineOf, type WorkspaceEntry } from '@client/workspaces'
import type { PanelRecord } from '@workspace/document/contract'
import { InlineEditInput, canvasKey, toggleCollapsed, useTreeCollapseStore } from '../../workspace/files'
import { WorkspaceSkillsTree } from '../../workspace/skills'
import { PanelIcon, PanelTitle, panelTitleLabel, usePanelTitles, type PanelDecoration } from '../../client/host'
import { clientApp } from '../app'
import { closePanels, closeWorkspace, detachPanel, renamePanel, revealPanel, selectWorkspace } from '../navigation'
import { panelsWithPorts, terminalCwd } from '@services/terminal/client'
import { useTerminalStatuses } from '../state/statusStore'
import { useUIStore } from '../state/uiStore'
import { useWindowId } from '../state/windowContext'
import { WorkspaceToggle } from './connectionStatus'
import { ShareSlot } from './ShareSlot'
import { WorkspaceActionsDialog, type WorkspaceAction } from './WorkspaceActionsDialog'
import { showMenu, type MenuItem } from './menu'
import { workspacePanelTree, type WindowTree } from './panelTree'

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

/** A folder for this computer's projects, a server for another computer's and a link for shared ones. */
function WorkspaceGlyph({ kind }: { kind: string }): JSX.Element {
  if (kind === 'paired') return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[color-mix(in_srgb,var(--text-primary)_10%,transparent)] text-primary"><Globe size={13} /></span>
  if (kind === 'local') return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-muted"><Folder size={15} /></span>
  return <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center text-muted"><Server size={15} /></span>
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
  const tree = useMemo(() => workspacePanelTree(doc, { windowId, rootPath }), [doc, windowId, rootPath])
  const statuses = useTerminalStatuses(isOpen ? workspaceId : null)
  const ports = panelsWithPorts(statuses)
  const titles = usePanelTitles(isOpen ? workspaceId : null)
  const showSkills = useClientSetting('showSkillsInWorkspaceOverview')
  const skillsViewOpen = useUIStore((s) => s.overlay?.view === 'skills')
  const collapsed = useTreeCollapseStore((s) => s.collapsed)

  const [renamingWorkspace, setRenamingWorkspace] = useState<string | null>(null)
  const [rename, setRename] = useState<RenameState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
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

  // Opens the workspace first when it is closed.
  const share = async () => {
    if (await selectWorkspace(workspaceId)) useUIStore.getState().openShare(workspaceId)
  }

  const workspaceCwd = (): string | undefined =>
    terminalCwd(statuses, isOpen ? focusedLeafPanelId(workspaceId) : null) ?? rootPath

  /** What the workspace can do; the native menu and the actions dialog list the same. */
  const workspaceActions = (): WorkspaceAction[] => {
    const cwd = workspaceCwd()
    return [
      { id: 'share', label: 'Invite to Workspace…', icon: <UserPlus size={15} />, run: () => void share() },
      { id: 'rename', label: 'Rename Workspace', icon: <Pencil size={15} />, run: beginRename },
      { id: 'settings', label: 'Workspace Settings…', icon: <Settings2 size={15} />, enabled: isOpen,
        run: () => { void selectWorkspace(workspaceId).then(() => useUIStore.getState().openSettings('runtime')) } },
      { id: 'skills', label: 'Skills…', icon: <Puzzle size={15} />, enabled: isOpen,
        run: () => { void selectWorkspace(workspaceId).then((ok) => { if (ok) useUIStore.getState().openOverlay({ view: 'skills' }) }) } },
      { id: 'copy-cwd', label: 'Copy Working Directory', icon: <Copy size={15} />, enabled: !!cwd, detail: cwd,
        run: () => { if (cwd) void clientUi().writeClipboard?.(cwd) } },
      { id: 'close-panels', label: 'Close All Panels', icon: <PanelsTopLeft size={15} />, enabled: isOpen && tree.count > 0,
        run: () => void closePanels(workspaceId, allPanelIds()) },
      { id: 'close', label: 'Close Workspace', icon: <LogOut size={15} />, danger: true, run: () => void closeWorkspace(workspaceId) },
    ]
  }

  const handleContextMenu = async (e: React.MouseEvent) => {
    if (onBulkContextMenu && (await onBulkContextMenu(e))) return
    e.preventDefault()
    e.stopPropagation()
    const actions = workspaceActions()
    const byId = new Map(actions.map((action) => [action.id, action]))
    const item = (id: string): MenuItem => ({ id, label: byId.get(id)!.label, enabled: byId.get(id)!.enabled })
    const items: MenuItem[] = [
      { id: 'select', label: 'Select Workspace', enabled: !isSelected },
      item('share'), item('rename'), item('settings'),
      { type: 'separator' },
      item('copy-cwd'), item('close-panels'),
      { type: 'separator' },
      item('close'),
    ]
    setMenuOpen(true)
    const id = await showMenu(items)
    setMenuOpen(false)
    if (id === 'select') void selectWorkspace(workspaceId)
    else if (id) byId.get(id)?.run()
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

  const renderPanel = (record: PanelRecord, indent: boolean) => (
    <WorkspacePanelRow
      key={record.id}
      record={record}
      indent={indent}
      decoration={titles.decorations[record.id]}
      hasPorts={ports.has(record.id)}
      worktreeKey={Object.keys(doc.worktrees).length >= 2 && record.worktreeId ? doc.worktrees[record.worktreeId]?.color : undefined}
      onClick={(e) => { e.stopPropagation(); void revealPanel(workspaceId, record.id) }}
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

  const renderWindow = (w: WindowTree) => (
    <React.Fragment key={w.windowId}>
      {w.canvases.map(({ record, children }) => {
        const isCollapsed = collapsed.has(canvasKey(workspaceId, record.id))
        return (
          <React.Fragment key={record.id}>
            <CanvasRow
              record={record}
              hasChildren={children.length > 0}
              collapsed={isCollapsed}
              onToggle={() => toggleCollapsed(canvasKey(workspaceId, record.id))}
              onClick={(e) => { e.stopPropagation(); void revealPanel(workspaceId, record.id) }}
              onContextMenu={(e) => void handlePanelMenu(e, record)}
            />
            {!isCollapsed && children.map((child) => renderPanel(child, true))}
          </React.Fragment>
        )
      })}
      {w.topLevel.map((record) => renderPanel(record, false))}
    </React.Fragment>
  )

  const location = machineOf(entry)
  const displayTitle = entry.name
  // Only a connected workspace shows its tree: the document mirror outlives a
  // dropped connection (it resumes from it), the sidebar does not show it.
  const connected = useConnectionState(isOpen ? connection : undefined).kind === 'connected'
  const canExpand = connected && tree.count > 0
  // The panels, as small icons, while collapsed.
  const collapsedRecords = tree.primary.canvases.flatMap(({ record, children }) => [record, ...children]).concat(tree.primary.topLevel)

  return (
    <div
      onContextMenu={(e) => void handleContextMenu(e)}
      data-workspace-id={workspaceId}
      // One card per workspace, like a thread: its header and its panels.
      className={`mx-2 my-1 rounded-md pb-1 transition-colors ${entry.kind !== 'local' ? 'border-l-2 border-[color-mix(in_srgb,var(--text-primary)_30%,transparent)] bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]' : ''} ${
        isMultiSelected || menuOpen
          ? 'bg-[color-mix(in_srgb,var(--surface-2)_50%,transparent)]'
          : 'hover:bg-[color-mix(in_srgb,var(--surface-2)_50%,transparent)]'
      }`}
    >
      <div
        className={`group flex items-center gap-1.5 h-9 px-1 cursor-pointer outline-none ${
          isSelected || isMultiSelected ? 'text-primary' : 'text-secondary hover:text-primary'
        }`}
        onClick={(e) => onClick(e)}
        aria-selected={isSelected}
        role="treeitem"
        aria-expanded={canExpand ? isExpanded : undefined}
      >
        <WorkspaceToggle connection={isOpen ? connection : undefined} />
        {canExpand
          ? (
            <button type="button" aria-label={isExpanded ? 'Collapse workspace' : 'Expand workspace'}
              onClick={(e) => { e.stopPropagation(); onToggleExpand() }}
              className="flex-shrink-0 rounded p-0.5 -m-0.5 hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-strong">
              <WorkspaceGlyph kind={entry.kind} />
            </button>
          )
          : <WorkspaceGlyph kind={entry.kind} />}
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
            className={`flex-1 min-w-0 text-[13px] text-secondary truncate ${isOpen ? '' : 'opacity-70'} ${isSelected ? 'cursor-text' : ''}`}
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
        {entry.kind !== 'local' && (
          <span className="flex max-w-28 shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] px-1.5 py-0.5 text-[10px] text-secondary" title={entry.kind === 'paired' ? 'Shared workspace, running on another computer' : 'Workspace on another computer'}>
            {entry.kind === 'paired' ? <Globe size={10} className="shrink-0" /> : <Server size={10} className="shrink-0" />}
            <span className="truncate">{'label' in location ? location.label ?? 'Remote computer' : ''}</span>
          </span>
        )}
        <ShareSlot workspaceId={workspaceId} isOpen={isOpen} isSelected={isSelected} onShare={() => void share()} />
        <Tooltip label="Workspace actions">
          <button
            className="flex-shrink-0 w-0 -ml-1.5 overflow-hidden opacity-0 group-hover:w-5 group-hover:ml-0 group-hover:opacity-80 focus-visible:w-5 focus-visible:ml-0 focus-visible:opacity-100 hover:!opacity-100 h-5 flex items-center justify-center text-secondary hover:text-primary transition-opacity focus:outline-none"
            onClick={(e) => { e.stopPropagation(); setActionsOpen(true) }}
            aria-label="Workspace actions"
          >
            <DotsThree size={14} />
          </button>
        </Tooltip>
      </div>
      {!isExpanded && canExpand && (
        <div className="flex items-center justify-start gap-0.5 pl-[7px] pr-2.5 pb-1.5 text-muted" aria-label={`${tree.count} panels`}>
          {collapsedRecords.slice(0, 8).map((record) => (
            <button
              key={record.id}
              type="button"
              title={panelTitleLabel(record, titles.decorations[record.id])}
              aria-label={panelTitleLabel(record, titles.decorations[record.id])}
              data-panel-id={record.id}
              onClick={(e) => { e.stopPropagation(); void revealPanel(workspaceId, record.id) }}
              className={`flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-hover hover:text-primary focus:outline-none focus-visible:ring-1 focus-visible:ring-strong ${
                titles.decorations[record.id]?.logo ? '' : 'opacity-80 hover:opacity-100'
              } ${titles.decorations[record.id]?.busy ? 'animate-pulse' : ''}`}
            >
              <PanelIcon type={record.type} size={11} logo={titles.decorations[record.id]?.logo} logoAlt={titles.decorations[record.id]?.logoAlt} />
            </button>
          ))}
          {collapsedRecords.length > 8 && <span className="text-[11px]">+{collapsedRecords.length - 8}</span>}
        </div>
      )}
      {actionsOpen && (
        <WorkspaceActionsDialog
          name={displayTitle}
          location={rootPath}
          actions={workspaceActions()}
          onClose={() => setActionsOpen(false)}
        />
      )}
      {isExpanded && canExpand && (
        <div className="flex flex-col" role="group">
          {renderWindow(tree.primary)}
          {tree.others.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 h-6 pl-7 pr-2 text-[11px] text-muted opacity-70">
                <span className="truncate">Other windows</span>
              </div>
              {tree.others.map(renderWindow)}
            </>
          )}
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
  indent: boolean
  decoration?: PanelDecoration
  hasPorts?: boolean
  /** The panel's worktree palette key, when worktrees are told apart. */
  worktreeKey?: string
  onClick: (e: React.MouseEvent) => void
  /** Middle-click closes. */
  onClose?: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  rename?: PanelRowRename | null
  onBeginRename?: () => void
}

export function WorkspacePanelRow({
  record,
  indent,
  decoration,
  hasPorts = false,
  worktreeKey,
  onClick,
  onClose,
  onContextMenu,
  rename,
  onBeginRename,
}: WorkspacePanelRowProps): JSX.Element {
  const label = panelTitleLabel(record, decoration)
  const running = !!decoration?.busy
  const awaiting = !!decoration?.status
  const inputRef = useRef<HTMLInputElement>(null)
  const renaming = !!rename
  useEffect(() => {
    if (renaming) { inputRef.current?.focus(); inputRef.current?.select() }
  }, [renaming])

  return (
    <button
      className={`group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pr-2 text-[13px] hover:bg-hover text-left min-w-0 focus:outline-none ${
        indent ? 'pl-10' : 'pl-7'
      } ${awaiting ? 'text-primary' : 'text-muted hover:text-primary'}`}
      onClick={onClick}
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
      <PanelTitle record={record} decoration={decoration} worktreeKey={worktreeKey} iconSize={11}
        onDoubleClick={(event) => { event.stopPropagation(); onBeginRename?.() }}>
        {rename ? <InlineEditInput
          ref={inputRef}
          className="flex-1 min-w-0 text-[13px] bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
          value={rename.value}
          onChange={rename.onChange}
          onSubmit={rename.onSubmit}
          onCancel={rename.onCancel}
        /> : undefined}
      </PanelTitle>
      {!awaiting && !running && hasPorts ? (
        <span className="flex-shrink-0 w-1.5 h-1.5 rounded-full bg-muted opacity-50" aria-label="listening on a port" />
      ) : null}
    </button>
  )
}

function CanvasRow({ record, hasChildren, collapsed, onToggle, onClick, onContextMenu }: {
  record: PanelRecord
  hasChildren: boolean
  collapsed: boolean
  onToggle: () => void
  onClick: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}): JSX.Element {
  const label = panelRowLabel(record)
  return (
    <div
      role="button"
      tabIndex={0}
      className="group/panel mx-1.5 my-0.5 rounded-lg flex items-center gap-1.5 h-7 pl-3 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 cursor-pointer focus:outline-none"
      onClick={onClick}
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
      <PanelTitle record={record} iconSize={11} />
    </div>
  )
}
