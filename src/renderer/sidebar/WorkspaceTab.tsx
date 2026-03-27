import React from 'react'
import { Bell, X } from 'lucide-react'
import type { WorkspaceState } from '../../shared/types'
import { useStatusStore, selectAllPorts, selectPrimaryCwd, selectGitInfo } from '../stores/statusStore'

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

  const ports = useStatusStore(() => selectAllPorts(workspace.id))
  const cwd = useStatusStore(() => selectPrimaryCwd(workspace.id))
  const gitInfo = useStatusStore(() => selectGitInfo(workspace.id))

  const panelCount = Object.keys(workspace.panels).length
  const claudeState = useStatusStore((s) => {
    const ws = s.workspaces[workspace.id]
    if (!ws) return 'notRunning'
    const vals = Object.values(ws.claudeCodeState)
    if (vals.includes('waitingForInput')) return 'waitingForInput'
    if (vals.includes('running')) return 'running'
    if (vals.includes('finished')) return 'finished'
    return 'notRunning'
  })

  const showClaudeStatus = claudeState === 'running' || claudeState === 'waitingForInput'
  const showNeedsInput = claudeState === 'waitingForInput'

  const displayPath = truncatePath(workspace.rootPath || workspace.name)

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

        <span className="flex-1 min-w-0 text-sm font-semibold truncate">
          {displayPath}
        </span>

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
    </div>
  )
}
