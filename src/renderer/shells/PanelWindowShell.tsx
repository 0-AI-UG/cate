// =============================================================================
// PanelWindowShell — borderless shell for detached panel windows.
// Renders a single panel with a custom title bar that serves as a drag handle.
// =============================================================================

import React, { useEffect, useState, useCallback, Suspense } from 'react'
import type { PanelState, PanelTransferSnapshot } from '../../shared/types'
import { terminalRegistry } from '../lib/terminalRegistry'

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
      }

      setPanel(snapshot.panel)
      setReceivedSnapshot(snapshot)
    })

    return cleanup
  }, [])

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
      <div className="h-screen w-screen flex items-center justify-center bg-[#1E1E24] text-zinc-500">
        <div className="text-sm">Loading panel...</div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-[#1E1E24] overflow-hidden">
      {/* Custom title bar — serves as drag handle */}
      <div
        className="flex items-center h-8 px-2 bg-[#1A1A20] border-b border-zinc-800 select-none shrink-0"
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
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </button>
      </div>

      {/* Panel content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Suspense fallback={<div className="w-full h-full bg-[#1e1e1e] flex items-center justify-center text-zinc-500 text-sm">Loading...</div>}>
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
  const iconClass = "w-3.5 h-3.5 text-zinc-500"
  switch (type) {
    case 'terminal':
      return (
        <svg className={iconClass} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <polyline points="4,4 8,8 4,12" />
          <line x1="9" y1="12" x2="13" y2="12" />
        </svg>
      )
    case 'editor':
      return (
        <svg className={iconClass} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="2" width="12" height="12" rx="1" />
          <line x1="5" y1="5" x2="11" y2="5" />
          <line x1="5" y1="8" x2="9" y2="8" />
          <line x1="5" y1="11" x2="11" y2="11" />
        </svg>
      )
    case 'browser':
      return (
        <svg className={iconClass} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6" />
          <line x1="2" y1="8" x2="14" y2="8" />
          <ellipse cx="8" cy="8" rx="3" ry="6" />
        </svg>
      )
    default:
      return (
        <svg className={iconClass} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="2" y="2" width="12" height="12" rx="1" />
        </svg>
      )
  }
}
