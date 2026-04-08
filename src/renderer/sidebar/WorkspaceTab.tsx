import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { X, CaretRight, Terminal as TerminalIcon, Globe, FileCode, GitBranch, Folder, FolderPlus, SquaresFour, List } from '@phosphor-icons/react'
import type { WorkspaceState, PanelType, PanelLocation } from '../../shared/types'
import { ALL_ZONES } from '../../shared/types'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, WORKSPACE_COLORS, getCanvasOperations } from '../stores/appStore'
import { useDockStore } from '../stores/dockStore'
import { findTabStack, findStackContainingPanel } from '../stores/dockTreeUtils'
import { useUIStore } from '../stores/uiStore'
import { useProjectUsage } from '../stores/usageStore'
import type { NativeContextMenuItem } from '../../shared/electron-api'

// -----------------------------------------------------------------------------
// Panel jump helper — focus a panel inside a workspace, switching workspace
// first if necessary. Mirrors notificationStore.executeAction polling logic.
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

    const ops = getCanvasOperations()
    const nodeId = ops?.storeApi?.getState()?.nodeForPanel(panelId)
    if (nodeId) { ops!.focusPanelNode(panelId); return }
  }
}

const PANEL_ICONS: Record<PanelType, typeof TerminalIcon> = {
  terminal: TerminalIcon,
  browser: Globe,
  editor: FileCode,
  git: GitBranch,
  fileExplorer: Folder,
  projectList: List,
  canvas: SquaresFour,
}

function formatTokensBadge(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const PULSE_KEYFRAMES = `
@keyframes sidebar-pulse-ring {
  0%   { transform: scale(1);   opacity: 0.6; }
  100% { transform: scale(2.2); opacity: 0; }
}
`
let stylesInjected = false
function ensurePulseStyles() {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.textContent = PULSE_KEYFRAMES
  document.head.appendChild(style)
}

const COLOR_NAMES: Record<string, string> = {
  '#5a9ed6': 'Blue',
  '#e8893a': 'Amber',
  '#7fc063': 'Green',
  '#b57ad0': 'Orchid',
  '#e05a4a': 'Red',
  '#4ec2c2': 'Teal',
}

function truncatePath(fullPath: string): string {
  if (!fullPath) return ''
  const segments = fullPath.split('/').filter(Boolean)
  if (segments.length <= 2) return fullPath
  return '.../' + segments.slice(-2).join('/')
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
  ensurePulseStyles()

  // Single store read for all workspace status data (avoids multiple O(n) loops)
  const wsStatus = useStatusStore(useShallow((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return null
    return {
      listeningPorts: ws.listeningPorts,
      terminalCwd: ws.terminalCwd,
      agentState: ws.agentState,
    }
  }))

  const gitInfo = useStatusStore((s) => s.gitInfo[workspace.id] ?? null)
  const projectUsage = useProjectUsage(workspace.rootPath || undefined)

  // Derive ports, cwd, claudeState from the single store snapshot
  const ports = useMemo(() => {
    if (!wsStatus) return []
    const allPorts = new Set<number>()
    for (const terminalPorts of Object.values(wsStatus.listeningPorts)) {
      for (const port of terminalPorts) allPorts.add(port)
    }
    return Array.from(allPorts).sort((a, b) => a - b)
  }, [wsStatus?.listeningPorts])

  const cwd = useMemo(() => {
    if (!wsStatus) return null
    const cwds = Object.values(wsStatus.terminalCwd)
    return cwds.length > 0 ? cwds[0] : null
  }, [wsStatus?.terminalCwd])

  const [isExpanded, setIsExpanded] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const handleContextMenu = useCallback(async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.electronAPI) return
    const colorSubmenu: NativeContextMenuItem[] = WORKSPACE_COLORS.map((color) => ({
      id: `color:${color}`,
      label: (COLOR_NAMES[color] || color) + (color === workspace.color ? ' ✓' : ''),
      enabled: color !== workspace.color,
    }))
    const items: NativeContextMenuItem[] = [
      { id: 'select', label: 'Select Workspace', enabled: !isSelected },
      { id: 'rename', label: 'Rename Workspace' },
      { label: 'Change Color', submenu: colorSubmenu },
      { type: 'separator' },
      { id: 'select-folder', label: 'Select Project Folder' },
      { id: 'agent-setup', label: 'Agent Setup' },
      { id: 'copy-cwd', label: 'Copy Working Directory' },
      { type: 'separator' },
      { id: 'duplicate', label: 'Duplicate Workspace' },
      { id: 'close-panels', label: 'Close All Panels', enabled: Object.keys(workspace.panels).length > 0 },
      { type: 'separator' },
      { id: 'remove', label: 'Close Workspace' },
    ]
    const id = await window.electronAPI.showContextMenu(items)
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
      case 'agent-setup':
        app.selectWorkspace(workspace.id)
        useUIStore.getState().setActiveRightSidebarView('aiConfig')
        break
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

  // Focus rename input when entering rename mode
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

  const panelCount = Object.keys(workspace.panels).length

  // Sorted panel list for expanded view (group by type for stability)
  const panelList = useMemo(() => {
    const TYPE_ORDER: Record<string, number> = { terminal: 0, editor: 1, browser: 2, git: 3, fileExplorer: 4, projectList: 5, canvas: 6 }
    return Object.values(workspace.panels).slice().sort((a, b) => {
      const ta = TYPE_ORDER[a.type] ?? 99
      const tb = TYPE_ORDER[b.type] ?? 99
      if (ta !== tb) return ta - tb
      return (a.title || '').localeCompare(b.title || '')
    })
  }, [workspace.panels])

  const handlePanelClick = useCallback(async (e: React.MouseEvent, panelId: string) => {
    e.stopPropagation()
    await focusWorkspacePanel(workspace.id, panelId)
  }, [workspace.id])

  // Empty state: workspace has no folder selected yet — render a muted
  // "Add new Workspace" card that opens the folder picker on click.
  // NOTE: placed after all hooks to keep hook order stable across renders.
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
        className={`group relative rounded-lg cursor-pointer transition-colors px-3 py-2.5 border border-dashed ${
          isSelected
            ? 'border-subtle bg-surface-5 text-secondary'
            : 'border-subtle bg-surface-4 text-muted hover:text-secondary hover:border-strong hover:bg-hover'
        }`}
        onClick={handlePickFolder}
        onContextMenu={handleContextMenu}
        title="Click to choose a project folder"
      >
        <div className="flex items-center gap-2">
          <FolderPlus size={14} className="flex-shrink-0 opacity-70" />
          <span className="flex-1 min-w-0 text-sm font-medium truncate">
            Add new Workspace
          </span>
          <button
            className="flex-shrink-0 opacity-40 hover:opacity-100 transition-opacity"
            onClick={(e) => {
              e.stopPropagation()
              onClose()
            }}
            title="Close Workspace"
          >
            <X size={14} />
          </button>
        </div>
        <div className="mt-1 text-[11px] opacity-60 truncate">
          Choose a project folder
        </div>
      </div>
    )
  }

  // Show custom name if user renamed the workspace, otherwise show the path
  const defaultName = workspace.rootPath ? workspace.rootPath.split('/').pop() || 'Workspace' : 'Workspace'
  const hasCustomName = workspace.name && workspace.name !== defaultName && workspace.name !== 'Workspace'
  const displayPath = hasCustomName ? workspace.name : truncatePath(workspace.rootPath || workspace.name)

  // Shorten home dir prefix to ~
  const home = typeof window !== 'undefined'
    ? (window as unknown as { process?: { env?: { HOME?: string } } })?.process?.env?.HOME || ''
    : ''
  const displayCwd = cwd
    ? (home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd)
    : null
  const displayCwdTruncated = displayCwd ? truncatePath(displayCwd) : null

  const gitDisplay = gitInfo
    ? `${gitInfo.branch}${gitInfo.isDirty ? '*' : ''}`
    : null

  const hasInfoRow = gitDisplay || displayCwdTruncated

  return (
    <div
      className={`group relative rounded-lg cursor-pointer transition-colors px-3 py-2.5 text-primary ${
        isSelected ? '' : 'bg-surface-5 hover:text-primary'
      }`}
      style={
        isSelected
          ? { backgroundColor: workspace.color }
          : ({ ['--ws-hover-bg' as never]: workspace.color } as React.CSSProperties)
      }
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = workspace.color
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.backgroundColor = ''
      }}
      onClick={onClick}
      onContextMenu={handleContextMenu}
    >
      {/* Row 1: Badge + Path + Close */}
      <div className="flex items-center gap-2">
        {panelCount > 0 ? (
          <button
            className="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center text-white relative group/badge"
            style={{ backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : workspace.color }}
            onClick={(e) => { e.stopPropagation(); setIsExpanded((v) => !v) }}
            title={isExpanded ? 'Collapse panels' : 'Expand panels'}
          >
            <span className="group-hover/badge:opacity-0 transition-opacity">{panelCount}</span>
            <CaretRight
              size={12}
              className={`absolute opacity-0 group-hover/badge:opacity-100 transition-all ${isExpanded ? 'rotate-90' : ''}`}
            />
          </button>
        ) : null}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="flex-1 min-w-0 text-sm font-semibold bg-surface-3 border border-subtle rounded px-1 py-0 outline-none text-primary"
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
            className="flex-1 min-w-0 text-sm font-semibold truncate"
            title={isSelected ? 'Click to rename' : undefined}
            onClick={(e) => {
              if (!isSelected) return
              e.stopPropagation()
              setRenameValue(workspace.name || workspace.rootPath.split('/').pop() || 'Workspace')
              setIsRenaming(true)
            }}
          >
            {displayPath}
          </span>
        )}

        <button
          className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          title="Close Workspace"
        >
          <X size={14} />
        </button>
      </div>

      {/* Row 2: Git branch + CWD */}
      {hasInfoRow && (
        <div className="mt-1 text-[11px] opacity-60 truncate">
          {gitDisplay && <span>{gitDisplay}</span>}
          {gitDisplay && displayCwdTruncated && <span> &bull; </span>}
          {displayCwdTruncated && <span>{displayCwdTruncated}</span>}
        </div>
      )}

      {/* Row 5: Listening ports */}
      {ports.length > 0 && (
        <div className="mt-0.5 text-[11px] opacity-60">
          {ports.map((p) => `:${p}`).join(', ')}
        </div>
      )}

      {/* Row 6: Token usage badge */}
      {projectUsage && projectUsage.totals.messageCount > 0 && (() => {
        const totalTok = projectUsage.totals.tokens.input
          + projectUsage.totals.tokens.output
          + projectUsage.totals.tokens.cacheCreate
          + projectUsage.totals.tokens.cacheRead
        if (totalTok === 0) return null
        const costStr = projectUsage.totals.costUsd !== null
          ? ` · $${projectUsage.totals.costUsd.toFixed(2)}`
          : ''
        return (
          <div className="mt-0.5 text-[10px] opacity-50 font-mono">
            {`\u25C6 ${formatTokensBadge(totalTok)} tok${costStr}`}
          </div>
        )
      })()}

      {/* Expanded panel list — click to jump */}
      {isExpanded && panelList.length > 0 && (
        <div className="mt-2 -mx-1 flex flex-col gap-0.5">
          {panelList.map((p) => {
            const Icon = PANEL_ICONS[p.type] ?? SquaresFour
            const label = p.title || p.filePath?.split('/').pop() || p.url || p.type
            return (
              <button
                key={p.id}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-secondary hover:text-primary hover:bg-surface-3 text-left min-w-0"
                onClick={(e) => handlePanelClick(e, p.id)}
                title={p.filePath || p.url || label}
              >
                <Icon size={12} className="flex-shrink-0 opacity-70" />
                <span className="truncate min-w-0 flex-1">{label}</span>
              </button>
            )
          })}
        </div>
      )}

    </div>
  )
}
