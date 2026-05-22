// =============================================================================
// PanelWindowShell — borderless shell for detached panel windows.
// Renders a single panel with a custom title bar that serves as a drag handle.
// =============================================================================

import React, { useEffect, useState, useCallback, Suspense } from 'react'
import { X } from '@phosphor-icons/react'
import type { PanelState, PanelTransferSnapshot } from '../../shared/types'
import { terminalRegistry } from '../lib/terminalRegistry'
import { terminalRestoreData } from '../lib/session'
import { DragOverlay, setupCrossWindowDragListeners, useDragOp } from '../drag'
import { renderPanelComponent, getPanelDef } from '../panels/registry'

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

  useEffect(() => {
    return setupCrossWindowDragListeners()
  }, [])

  const { handleDragStart } = useDragOp()

  // If we have panel info from query params but no transfer yet, show a loading state
  const displayPanel = panel

  const handleClose = useCallback(() => {
    window.close()
  }, [])

  /** Double-click title bar → dock panel back into main window */
  const handleTitleDoubleClick = useCallback(() => {
    window.electronAPI.panelWindowDockBack()
  }, [])

  /** Mousedown on the title bar starts a cross-window drag of this panel.
   *  When the cursor leaves the window, useDragOp emits cross-window-start,
   *  and the main process hands the cursor's snapshot to other windows. On a
   *  successful claim, commit's removeFromSource closes this window. */
  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!displayPanel) return
      if (e.button !== 0) return
      handleDragStart(e, {
        kind: 'panel-window',
        panelId: displayPanel.id,
        panelType: displayPanel.type,
        panelTitle: displayPanel.title ?? '',
        panel: displayPanel,
      })
    },
    [displayPanel, handleDragStart],
  )

  if (!displayPanel) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-surface-4 text-muted">
        <div className="text-sm">Loading panel...</div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen flex flex-col bg-surface-4 overflow-hidden">
      {/* Custom title bar.
       *  - Right side (title + close): -webkit-app-region: drag → OS-native
       *    window move (so the user can still reposition the panel window).
       *  - Left grip (panel icon): no-drag + onMouseDown → initiates a
       *    cross-window panel drag, so the user can dock this panel back
       *    into the main app or onto another Cate window. */}
      <div
        className="flex items-center h-8 px-2 bg-titlebar-bg border-b border-subtle select-none shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        onDoubleClick={handleTitleDoubleClick}
      >
        <div
          className="flex items-center justify-center w-5 h-5 mr-1 rounded hover:bg-hover cursor-grab active:cursor-grabbing"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onMouseDown={handleTitleMouseDown}
          title="Drag to dock"
        >
          <PanelTypeIcon type={displayPanel.type} />
        </div>
        <span className="text-xs text-secondary truncate flex-1 min-w-0">{displayPanel.title}</span>
        <button
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-hover text-muted hover:text-primary transition-colors"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={handleClose}
          title="Close"
        >
          <X size={10} />
        </button>
      </div>

      <DragOverlay />

      {/* Panel content */}
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <Suspense fallback={<div className="w-full h-full bg-surface-4 flex items-center justify-center text-muted text-sm">Loading...</div>}>
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
  const content = renderPanelComponent(panel, { workspaceId, nodeId: '' })
  if (!content) return <div className="w-full h-full flex items-center justify-center text-muted">Unknown panel type</div>
  return content
}

// -----------------------------------------------------------------------------
// Panel type icon
// -----------------------------------------------------------------------------

function PanelTypeIcon({ type }: { type: string }) {
  const Icon = getPanelDef(type).icon
  return <Icon size={14} className="text-muted" />
}
