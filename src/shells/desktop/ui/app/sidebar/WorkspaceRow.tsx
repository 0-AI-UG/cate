// One workspace in the sidebar: its row (name, connection state, panel count,
// menu) and, expanded, its panel tree from the document: canvases with their
// panels, top-level panels, the panels of its other windows, and its skills.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight as CaretRight, Ellipsis as DotsThree, Folder, FolderOpen, Link2 } from 'lucide-react'
import { Icon, Tooltip } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { useConnectionState, useWorkspaceRoot } from '../../client/connections'
import { useDocument } from '../../client/document'
import { focusedLeafPanelId, panelRowLabel } from '@client/host'
import type { WorkspaceEntry } from '@client/workspaces'
import type { PanelRecord } from '@workspace/document/contract'
import { InlineEditInput, canvasKey, toggleCollapsed, useTreeCollapseStore } from '../../workspace/files'
import { useWorktreeColor } from '../../workspace/repository'
import { WorkspaceSkillsTree } from '../../workspace/skills'
import { AgentActivityTitle, AwaitingIndicator, RunningIndicator, agentInfoTitle, useAgentInfoByPanel, type AgentPanelInfo } from '../../services/agents'
import { clientApp } from '../app'
import { closePanels, closeWorkspace, detachPanel, renamePanel, revealPanel, selectWorkspace } from '../navigation'
import { panelIcon } from '../panels'
import { panelsWithPorts, terminalCwd, useTerminalStatuses } from '../state/statusStore'
import { useUIStore } from '../state/uiStore'
import { useWindowId } from '../state/windowContext'
import { WorkspaceToggle } from './connectionStatus'
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

  const renderPanel = (record: PanelRecord, indent: boolean) => (
    <WorkspacePanelRow
      key={record.id}
      record={record}
      indent={indent}
      agent={agents[record.id]}
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
        <div className="flex flex-col" role="group">
          {renderWindow(tree.primary)}
          {tree.others.length > 0 && (
            <>
              <div className="flex items-center gap-1.5 h-6 pl-7 pr-2 text-[11px] uppercase tracking-wide text-muted opacity-70">
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
  agent?: AgentPanelInfo
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
  agent,
  hasPorts = false,
  worktreeKey,
  onClick,
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
        <AgentActivityTitle
          className="min-w-0 flex-1 truncate"
          worktreeColor={worktreeColor}
          onDoubleClick={(e) => { e.stopPropagation(); onBeginRename?.() }}
        >
          {label}
        </AgentActivityTitle>
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
      <Icon name={panelIcon(record.type)} size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
      <span className="truncate min-w-0 flex-1">{label}</span>
    </div>
  )
}
