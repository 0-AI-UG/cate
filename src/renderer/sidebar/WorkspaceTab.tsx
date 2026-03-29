import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useShallow } from 'zustand/shallow'
import { Bell, X } from 'lucide-react'
import type { WorkspaceState } from '../../shared/types'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, WORKSPACE_COLORS } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import ContextMenu, { type ContextMenuItem } from '../ui/ContextMenu'

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
  '#007AFF': 'Blue',
  '#FF9500': 'Orange',
  '#34C759': 'Green',
  '#AF52DE': 'Purple',
  '#FF3B30': 'Red',
  '#5AC8FA': 'Teal',
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

  const isAnimating = useStatusStore((s) => s.isAnimating(workspace.id))

  // Single store read for all workspace status data (avoids multiple O(n) loops)
  const wsStatus = useStatusStore(useShallow((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return null
    return {
      listeningPorts: ws.listeningPorts,
      terminalCwd: ws.terminalCwd,
      claudeCodeState: ws.claudeCodeState,
    }
  }))

  const gitInfo = useStatusStore((s) => s.gitInfo[workspace.id] ?? null)

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

  const claudeState = useMemo(() => {
    if (!wsStatus) return 'notRunning'
    const vals = Object.values(wsStatus.claudeCodeState)
    if (vals.includes('waitingForInput')) return 'waitingForInput'
    if (vals.includes('running')) return 'running'
    if (vals.includes('finished')) return 'finished'
    return 'notRunning'
  }, [wsStatus?.claudeCodeState])

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

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

  const contextMenuItems = useMemo((): ContextMenuItem[] => {
    const { selectWorkspace, setWorkspaceColor, duplicateWorkspace, removeWorkspace, setWorkspaceRootPath, closeAllPanels } = useAppStore.getState()

    const colorSwatch = (c: string) => (
      <span className="inline-block w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: c }} />
    )
    const colorSubmenu: ContextMenuItem[] = WORKSPACE_COLORS.map((color) => ({
      label: COLOR_NAMES[color] || color,
      icon: colorSwatch(color),
      onClick: () => setWorkspaceColor(workspace.id, color),
      disabled: color === workspace.color,
    }))

    return [
      {
        label: 'Select Workspace',
        onClick: () => selectWorkspace(workspace.id),
        disabled: isSelected,
      },
      {
        label: 'Rename Workspace',
        onClick: () => {
          setRenameValue(workspace.name || workspace.rootPath.split('/').pop() || 'Workspace')
          setIsRenaming(true)
        },
      },
      {
        label: 'Change Color',
        onClick: () => {},
        submenu: colorSubmenu,
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Select Project Folder',
        onClick: async () => {
          const path = await window.electronAPI.openFolderDialog()
          if (path) setWorkspaceRootPath(workspace.id, path)
        },
      },
      {
        label: 'Agent Setup',
        onClick: () => {
          selectWorkspace(workspace.id)
          useUIStore.getState().setActiveRightSidebarView('aiConfig')
        },
      },
      {
        label: 'Copy Working Directory',
        onClick: () => {
          const statusState = useStatusStore.getState()
          const wsStatus = statusState.workspaces[workspace.id]
          let dir: string | undefined
          if (wsStatus) {
            const cwds = Object.values(wsStatus.terminalCwd)
            dir = cwds[0]
          }
          if (!dir) dir = workspace.rootPath || undefined
          if (dir) navigator.clipboard.writeText(dir)
        },
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Duplicate Workspace',
        onClick: () => duplicateWorkspace(workspace.id),
      },
      {
        label: 'Close All Panels',
        onClick: () => closeAllPanels(workspace.id),
        disabled: Object.keys(workspace.panels).length === 0,
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Close Workspace',
        onClick: () => removeWorkspace(workspace.id),
        danger: true,
      },
    ]
  }, [workspace.id, workspace.name, workspace.rootPath, workspace.panels, isSelected])

  const panelCount = Object.keys(workspace.panels).length

  const showClaudeStatus = claudeState === 'running' || claudeState === 'waitingForInput'
  const showNeedsInput = claudeState === 'waitingForInput'

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
      className={`relative rounded-lg cursor-pointer transition-colors px-3 py-2.5 ${
        isSelected
          ? 'text-white'
          : 'hover:bg-white/[0.05] text-white/80'
      }`}
      style={isSelected ? { backgroundColor: workspace.color } : undefined}
      onClick={onClick}
      onContextMenu={handleContextMenu}
    >
      {/* Row 1: Badge + Path + Close */}
      <div className="flex items-center gap-2">
        {panelCount > 0 && (
          <span
            className="flex-shrink-0 w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center text-white"
            style={{ backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : workspace.color }}
          >
            {panelCount}
          </span>
        )}

        {isRenaming ? (
          <input
            ref={renameInputRef}
            className="flex-1 min-w-0 text-sm font-semibold bg-black/30 border border-white/20 rounded px-1 py-0 outline-none text-white"
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
          <span className="flex-1 min-w-0 text-sm font-semibold truncate">
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

      {/* Row 2: Claude status text */}
      {showClaudeStatus && (
        <div className="mt-1 text-xs opacity-80">
          {claudeState === 'waitingForInput'
            ? 'Claude is waiting for your input'
            : 'Claude is running'}
        </div>
      )}

      {/* Row 3: Needs input badge */}
      {showNeedsInput && (
        <div className="mt-1 flex items-center gap-1 text-xs">
          <Bell size={12} className="text-orange-400" />
          <span className="text-orange-400 font-medium">Needs input</span>
        </div>
      )}

      {/* Row 4: Git branch + CWD */}
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

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}
    </div>
  )
}
