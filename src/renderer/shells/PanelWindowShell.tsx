// =============================================================================
// PanelWindowShell — borderless shell for detached panel windows.
// Renders a single panel with a custom title bar that serves as a drag handle.
// =============================================================================

import React, { useEffect, useState, useCallback, Suspense } from 'react'
import { X, Terminal, FileText, Globe, Square } from '@phosphor-icons/react'
import type { PanelState, PanelTransferSnapshot } from '../../shared/types'
import { terminalRegistry } from '../lib/terminalRegistry'
import { terminalRestoreData } from '../lib/session'

const TerminalPanel = React.lazy(() => import('../panels/TerminalPanel'))
const EditorPanel = React.lazy(() => import('../panels/EditorPanel'))
const BrowserPanel = React.lazy(() => import('../panels/BrowserPanel'))
const GitPanel = React.lazy(() => import('../panels/GitPanel'))
const FileExplorerPanel = React.lazy(() => import('../panels/FileExplorerPanel'))
const ProjectListPanel = React.lazy(() => import('../panels/ProjectListPanel'))

interface PanelWindowShellProps {
  panelType?: string
  panelId?: string
  workspaceId?: string
}

export default function PanelWindowShell({ panelType, panelId, workspaceId }: PanelWindowShellProps) {
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [receivedSnapshot, setReceivedSnapshot] = useState<PanelTransferSnapshot | null>(null)

  // Listen for incoming panel transfers from the main process
  useEffect(() => {
    const cleanup = window.electronAPI.onPanelReceive((snapshot: PanelTransferSnapshot) => {
      // Deposit transfer data BEFORE setting state (which triggers TerminalPanel mount)
      if (snapshot.terminalPtyId) {
        terminalRegistry.setPendingTransfer(snapshot.panel.id, snapshot.terminalPtyId, snapshot.terminalScrollback)
      } else if (snapshot.terminalReplayPtyId && snapshot.panel.type === 'terminal') {
        // Session restore: no live PTY, but a previous run wrote a scrollback
        // log under this ptyId. Seed terminalRestoreData so getOrCreate runs
        // replayTerminalLog after spawning a fresh PTY.
        terminalRestoreData.set(snapshot.panel.id, { replayFromId: snapshot.terminalReplayPtyId })
      }

      setPanel(snapshot.panel)
      setReceivedSnapshot(snapshot)
    })

    return cleanup
  }, [])

  // For terminal panel windows: report ptyId to main + periodically save
  // scrollback so it can be replayed on next launch.
  useEffect(() => {
    if (!panel || panel.type !== 'terminal') return
    const panelId = panel.id

    let reportedPtyId: string | null = null

    const captureScrollback = (): void => {
      const entry = terminalRegistry.getEntry(panelId)
      if (!entry?.ptyId) return
      if (reportedPtyId !== entry.ptyId) {
        reportedPtyId = entry.ptyId
        window.electronAPI.panelWindowSyncPty(entry.ptyId).catch(() => {})
      }
      const buffer = entry.terminal.buffer.active
      const lastRow = buffer.baseY + buffer.cursorY
      const lines: string[] = []
      for (let i = 0; i < lastRow; i++) {
        const line = buffer.getLine(i)
        if (line) lines.push(line.translateToString(true))
      }
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const content = lines.join('\n')
      if (content) {
        window.electronAPI.terminalScrollbackSave(entry.ptyId, content).catch(() => {})
      }
    }

    // Wait for the terminal to be created before the first capture
    const initialDelay = setTimeout(captureScrollback, 1000)
    const interval = setInterval(captureScrollback, 5000)

    const handleBeforeUnload = (): void => captureScrollback()
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      clearTimeout(initialDelay)
      clearInterval(interval)
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [panel])

  // If we have panel info from query params but no transfer yet, show a loading state
  const displayPanel = panel

  const handleClose = useCallback(() => {
    window.close()
  }, [])

  /** Double-click title bar → dock panel back into main window */
  const handleTitleDoubleClick = useCallback(() => {
    window.electronAPI.panelWindowDockBack()
  }, [])

  if (!displayPanel) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#1f1e1c] text-zinc-500">
        <div className="text-sm">Loading panel...</div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1f1e1c] overflow-hidden">
      {/* Custom title bar — serves as drag handle */}
      <div
        className="flex items-center h-8 px-2 bg-[#1a1917] border-b border-zinc-800 select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        onDoubleClick={handleTitleDoubleClick}
      >
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <PanelTypeIcon type={displayPanel.type} />
          <span className="text-xs text-zinc-400 truncate">{displayPanel.title}</span>
        </div>
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300 transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={handleClose}
          title="Close"
        >
          <X size={10} />
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Suspense fallback={<div className="w-full h-full bg-[#1f1e1c] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
          <PanelContent panel={displayPanel} workspaceId={workspaceId ?? ''} />
        </Suspense>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Panel content renderer
// -----------------------------------------------------------------------------

function PanelContent({ panel, workspaceId }: { panel: PanelState; workspaceId: string }) {
  switch (panel.type) {
    case 'terminal':
      return <TerminalPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" />
    case 'editor':
      return <EditorPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" filePath={panel.filePath} />
    case 'browser':
      return <BrowserPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" url={panel.url} zoomLevel={1} />
    case 'git':
      return <GitPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" />
    case 'fileExplorer':
      return <FileExplorerPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" />
    case 'projectList':
      return <ProjectListPanel panelId={panel.id} workspaceId={workspaceId} nodeId="" />
    default:
      return <div className="w-full h-full flex items-center justify-center text-zinc-500">Unknown panel type</div>
  }
}

// -----------------------------------------------------------------------------
// Panel type icon
// -----------------------------------------------------------------------------

function PanelTypeIcon({ type }: { type: string }) {
  const iconClass = "text-zinc-500"
  const props = { size: 14, className: iconClass }
  switch (type) {
    case 'terminal':
      return <Terminal {...props} />
    case 'editor':
      return <FileText {...props} />
    case 'browser':
      return <Globe {...props} />
    default:
      return <Square {...props} />
  }
}
