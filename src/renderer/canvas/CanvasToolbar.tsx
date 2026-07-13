// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React, { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Terminal,
  Globe,
  FileText,
  Minus,
  Plus,
  Cursor,
  Hand,
  ChatCircle,
} from '@phosphor-icons/react'
import WorktreeToolbarMenu from './WorktreeToolbarMenu'
import ExtensionToolbarMenu from './ExtensionToolbarMenu'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useUIStore } from '../stores/uiStore'
import { useResolvedShortcuts } from '../stores/shortcutStore'
import { displayString, PANEL_DEFAULT_SIZES } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { inheritedWorktreeFromSelection } from '../lib/inheritWorktree'
import { Tooltip } from '../ui/Tooltip'

interface CanvasToolbarProps {
  canvasPanelId: string
  workspaceId: string
  rootPath: string
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onNewAgent: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

const ToolbarButton: React.FC<{
  onClick: () => void
  title: string
  size?: 'panel' | 'zoom'
  active?: boolean
  onMouseDown?: (e: React.MouseEvent) => void
  children: React.ReactNode
}> = ({ onClick, title, size = 'panel', active = false, onMouseDown, children }) => {
  const sizeClass = size === 'panel' ? 'w-9 h-9' : 'w-8 h-8'
  const activeClass = active ? 'bg-hover-strong' : 'bg-transparent'
  return (
    <Tooltip label={title} placement="top">
      <button
        type="button"
        onClick={onClick}
        onMouseDown={onMouseDown}
        aria-label={title}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className={`${sizeClass} ${activeClass} flex items-center justify-center rounded-full text-secondary hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// Terminal button with drag-to-place: a plain click opens the recommendation
// picker (onClick), while dragging onto the canvas spawns a ghost that follows
// the cursor and drops a terminal at that exact spot (explicit position →
// bypasses the picker). The cursor is treated as the new terminal's centre.
const TerminalSpawnButton: React.FC<{ onClick: () => void; canvasPanelId: string }> = ({ onClick, canvasPanelId }) => {
  const canvasApi = useCanvasStoreApi()
  const [ghost, setGhost] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const justDragged = useRef(false)

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let moved = false

    const onMove = (ev: MouseEvent) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return
      moved = true
      const zoom = canvasApi.getState().zoomLevel
      const base = PANEL_DEFAULT_SIZES.terminal
      const w = base.width * zoom
      const h = base.height * zoom
      setGhost({ x: ev.clientX - w / 2, y: ev.clientY - h / 2, w, h })
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
      setGhost(null)
      if (!moved) return // a click — let onClick open the picker
      justDragged.current = true // suppress the click that follows this drag
      const target = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const container = target?.closest('[data-canvas-container]') as HTMLElement | null
      if (!container) return
      const rect = container.getBoundingClientRect()
      const center = canvasApi
        .getState()
        .viewToCanvas({ x: ev.clientX - rect.left, y: ev.clientY - rect.top })
      const base = PANEL_DEFAULT_SIZES.terminal
      const pos = { x: center.x - base.width / 2, y: center.y - base.height / 2 }
      const app = useAppStore.getState()
      const wsId = app.selectedWorkspaceId
      // Pin to this toolbar's canvas so the drop lands here, not on the
      // workspace's primary canvas (matters on secondary/nested canvases), and
      // inherit the selected terminal/agent's worktree like the click path does.
      if (wsId) {
        const wt = inheritedWorktreeFromSelection(canvasApi.getState(), app.getWorkspace(wsId)?.panels)
        const newId = app.createTerminal(wsId, undefined, pos, { target: 'canvas', canvasPanelId }, wt.cwd)
        if (newId && wt.worktreeId) app.setPanelWorktreeId(wsId, newId, wt.worktreeId)
      }
    }
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
  }

  return (
    <>
      <ToolbarButton
        onClick={() => {
          if (justDragged.current) { justDragged.current = false; return }
          onClick()
        }}
        onMouseDown={handleMouseDown}
        title="Terminal. Click for recommendations, or drag onto the canvas."
        size="panel"
      >
        <Terminal size={18} />
      </ToolbarButton>
      {ghost &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              left: ghost.x, top: ghost.y, width: ghost.w, height: ghost.h,
              borderRadius: 8,
              border: '1.5px solid rgba(74, 158, 255, 0.75)',
              background: 'rgba(74, 158, 255, 0.1)',
              boxShadow: '0 12px 32px rgba(0,0,0,0.4)',
              pointerEvents: 'none',
              zIndex: 2147483000,
              overflow: 'hidden',
              backdropFilter: 'blur(1px)',
            }}
          >
            <div style={{ height: 22, background: 'rgba(74, 158, 255, 0.22)',
              display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px',
              color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: 600,
              fontFamily: 'var(--font-sans)' }}>
              <Terminal size={12} /> Terminal
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

// A tool-mode button that fills when active. The bound shortcut is surfaced on
// hover via the shared Tooltip (native `title` tooltips are flaky in Electron).
const ModeButton: React.FC<{
  onClick: () => void
  title: string
  active: boolean
  children: React.ReactNode
}> = ({ onClick, title, active, children }) => {
  const activeClass = active ? 'bg-hover-strong' : 'bg-transparent'
  return (
    <Tooltip label={title} placement="top">
      <button
        type="button"
        onClick={onClick}
        aria-label={title}
        style={{ WebkitTapHighlightColor: 'transparent' }}
        className={`w-9 h-9 ${activeClass} flex items-center justify-center rounded-full ${active ? 'text-primary' : 'text-secondary'} hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  canvasPanelId,
  workspaceId,
  rootPath,
  zoom,
  onNewTerminal,
  onNewBrowser,
  onNewEditor,
  onNewAgent,
  onZoomIn,
  onZoomOut,
}) => {
  const canvasApi = useCanvasStoreApi()
  const activeTool = useUIStore((s) => s.activeTool)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const shortcuts = useResolvedShortcuts()
  const toggleToolKey = displayString(shortcuts.toggleTool)
  const newBrowserKey = displayString(shortcuts.newBrowser)
  const newEditorKey = displayString(shortcuts.newEditor)
  const zoomInKey = displayString(shortcuts.zoomIn)
  const zoomOutKey = displayString(shortcuts.zoomOut)
  const zoomResetKey = displayString(shortcuts.zoomReset)
  const zoomText = `${Math.round(zoom * 100)}%`

  return (
    <div className="absolute inset-x-0 bottom-4 z-50 flex justify-center pointer-events-none">
      <div data-onboarding="toolbar" className="relative pointer-events-auto">
        <div className="rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-0.5 px-1 py-1">
            {/* Interaction tools (Select / Hand) */}
            <ModeButton
              onClick={() => setActiveTool('select')}
              title={`Select tool (Space, or ${toggleToolKey} inside a panel)`}
              active={activeTool === 'select'}
            >
              <Cursor size={18} />
            </ModeButton>
            <ModeButton
              onClick={() => setActiveTool('hand')}
              title={`Hand tool for panning (Space, or ${toggleToolKey} inside a panel)`}
              active={activeTool === 'hand'}
            >
              <Hand size={18} />
            </ModeButton>

            {/* Parallel worktrees — drop-up: focus a worktree's spatial lens,
                open a terminal in one, or start a new parallel branch. */}
            <WorktreeToolbarMenu
              canvasPanelId={canvasPanelId}
              workspaceId={workspaceId}
              rootPath={rootPath}
            />

            {/* Divider */}
            <div className="w-px h-5 bg-surface-5 mx-1" />

            {/* Basic panel buttons */}
            <TerminalSpawnButton onClick={onNewTerminal} canvasPanelId={canvasPanelId} />
            <ToolbarButton onClick={onNewBrowser} title={`Browser (${newBrowserKey})`} size="panel">
              <Globe size={18} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewEditor} title={`Editor (${newEditorKey})`} size="panel">
              <FileText size={18} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewAgent} title="Agent" size="panel">
              <ChatCircle size={18} />
            </ToolbarButton>

            {/* Extensions — only shown when an enabled extension exposes a panel.
                One panel opens directly; several open a drop-up picker. */}
            <ExtensionToolbarMenu canvasPanelId={canvasPanelId} workspaceId={workspaceId} />

            {/* Divider */}
            <div className="w-px h-5 bg-surface-5 mx-1" />

            {/* Zoom controls */}
            <ToolbarButton onClick={onZoomOut} title={`Zoom Out (${zoomOutKey})`} size="zoom">
              <Minus size={16} />
            </ToolbarButton>
            <Tooltip label={`Reset zoom to 100% (${zoomResetKey})`} placement="top">
              <button
                type="button"
                onClick={() => canvasApi.getState().animateZoomTo(1.0)}
                aria-label={`Reset zoom to 100% (${zoomResetKey})`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
                className="text-[11px] font-mono text-secondary hover:text-primary min-w-[40px] text-center select-none rounded-full bg-transparent hover:bg-hover-strong active:bg-hover-strong cursor-pointer px-1.5 py-1 focus:outline-none focus-visible:outline-none transition-all duration-100"
              >
                {zoomText}
              </button>
            </Tooltip>
            <ToolbarButton onClick={onZoomIn} title={`Zoom In (${zoomInKey})`} size="zoom">
              <Plus size={16} />
            </ToolbarButton>
          </div>
        </div>
      </div>

    </div>
  )
}

export default React.memo(CanvasToolbar)
