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
  MapTrifold,
  Cursor,
  Hand,
  X,
  Sparkle,
} from '@phosphor-icons/react'
import Minimap from './Minimap'
import WorktreeToolbarMenu from './WorktreeToolbarMenu'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useUIStore } from '../stores/uiStore'
import { useUIStateStore } from '../stores/uiStateStore'
import { cornerFromPoint } from '../lib/canvasCorners'
import { useShortcutStore } from '../stores/shortcutStore'
import { displayString, PANEL_DEFAULT_SIZES } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { Tooltip } from '../ui/Tooltip'
import { CateAgentToolbarButton } from '../cateAgent/CateAgentToolbarButton'
import { CateAgentInputBar } from '../cateAgent/CateAgentInputBar'
import { CateAgentFeedback } from '../cateAgent/CateAgentFeedback'
import { useCateAgentWs, useCateAgentStore } from '../cateAgent/cateAgentStore'
import { cateAgentController } from '../cateAgent/cateAgentController'

interface CanvasToolbarProps {
  canvasPanelId: string
  workspaceId: string
  rootPath: string
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onNewAgent: () => void
  onNewCanvas: () => void
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
      const wsId = useAppStore.getState().selectedWorkspaceId
      // Pin to this toolbar's canvas so the drop lands here, not on the
      // workspace's primary canvas (matters on secondary/nested canvases).
      if (wsId) useAppStore.getState().createTerminal(wsId, undefined, pos, { target: 'canvas', canvasPanelId })
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
              fontFamily: 'system-ui, -apple-system, sans-serif' }}>
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
  onNewCanvas,
  onZoomIn,
  onZoomOut,
}) => {
  const canvasApi = useCanvasStoreApi()
  const minimapOpen = useUIStore((s) => s.minimapOpen)
  const toggleMinimapOpen = useUIStore((s) => s.toggleMinimapOpen)
  const activeTool = useUIStore((s) => s.activeTool)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const toggleToolKey = useShortcutStore((s) => displayString(s.shortcuts.toggleTool))
  const newBrowserKey = useShortcutStore((s) => displayString(s.shortcuts.newBrowser))
  const newEditorKey = useShortcutStore((s) => displayString(s.shortcuts.newEditor))
  const zoomInKey = useShortcutStore((s) => displayString(s.shortcuts.zoomIn))
  const zoomOutKey = useShortcutStore((s) => displayString(s.shortcuts.zoomOut))
  const zoomResetKey = useShortcutStore((s) => displayString(s.shortcuts.zoomReset))
  const zoomText = `${Math.round(zoom * 100)}%`

  const cateAgent = useCateAgentWs(workspaceId)
  const inputOpen = cateAgent.inputOpen
  const toggleAgentInput = () => useCateAgentStore.getState().setInputOpen(workspaceId, !inputOpen)
  const closeAgentInput = () => useCateAgentStore.getState().setInputOpen(workspaceId, false)
  const sendAgentPrompt = (text: string) => void cateAgentController.prompt(workspaceId, rootPath, text)

  // Minimap pill docking corner + drag-to-dock handling. The corner is driven
  // straight from the UI-state store so an external shove (the Cate Agent landing on
  // this corner) moves the pill immediately. The toggle button doubles as a
  // drag handle: a click toggles the map, a drag past a small threshold re-docks
  // the pill to whichever corner the cursor ends up in.
  const minimapCorner = useUIStateStore((s) => s.minimapButtonCorner)
  const minimapDidDragRef = useRef(false)
  const minimapPillRef = useRef<HTMLDivElement>(null)
  const mmBottom = minimapCorner.startsWith('bottom')
  const mmRight = minimapCorner.endsWith('right')

  const handleMinimapHandleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    minimapDidDragRef.current = false
    // Resolve corners against this canvas's own area so the quadrant split lines
    // up with where the pill (and the Cate Agent) actually render.
    const area = minimapPillRef.current?.closest('[data-canvas-area]')
    const rect = area?.getBoundingClientRect() ??
      { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
    const onMove = (ev: MouseEvent) => {
      if (!minimapDidDragRef.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) {
        return
      }
      minimapDidDragRef.current = true
      const next = cornerFromPoint(ev.clientX, ev.clientY, rect)
      const store = useUIStateStore.getState()
      const prev = store.minimapButtonCorner
      if (next === prev) return
      store.setUIState('minimapButtonCorner', next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const handleMinimapToggleClick = () => {
    // Suppress the click that fires at the end of a drag gesture.
    if (minimapDidDragRef.current) {
      minimapDidDragRef.current = false
      return
    }
    toggleMinimapOpen()
  }

  return (
    <>
    <div className="absolute inset-x-0 bottom-4 z-50 flex justify-center pointer-events-none">
      <div data-onboarding="toolbar" className="relative pointer-events-auto">
        <CateAgentFeedback workspaceId={workspaceId} rootPath={rootPath} />
        <div className="rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-0.5 px-1 py-1">
            {/* Cate Agent — always leftmost; toggles the prompt input. */}
            <CateAgentToolbarButton
              activity={cateAgent.activity}
              active={inputOpen}
              onClick={toggleAgentInput}
            />
            {/* Content zone: the tools always render and define the toolbar's
                base width; the input bar fades in over them when open. Opening
                grows the zone slightly (animated padding) so the input is a bit
                wider than the toolbar, then collapses back on close. */}
            <div
              className="relative flex items-center gap-0.5 ml-1.5 transition-[padding] duration-200 ease-out"
              style={{ paddingRight: inputOpen ? 96 : 0 }}
            >
              <div
                className={`flex items-center gap-0.5 transition-opacity duration-150 ${
                  inputOpen ? 'pointer-events-none opacity-0' : 'opacity-100'
                }`}
              >
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
              <Sparkle size={18} />
            </ToolbarButton>

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
              {inputOpen && (
                <div className="absolute inset-0 flex items-center">
                  <CateAgentInputBar onSend={sendAgentPrompt} onClose={closeAgentInput} />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

    </div>

    {/* Minimap — pill button docked to any corner. The pill grows toward the
        canvas centre to reveal the map, while the toggle button stays pinned to
        the docked corner so open and close feel like the same gesture. Drag the
        button to re-dock the pill to a different corner. */}
    <div
      ref={minimapPillRef}
      className="absolute z-50 flex gap-2"
      style={{
        ...(mmBottom ? { bottom: '1rem' } : { top: '1rem' }),
        ...(mmRight ? { right: '1rem' } : { left: '1rem' }),
        flexDirection: mmRight ? 'row' : 'row-reverse',
        alignItems: mmBottom ? 'flex-end' : 'flex-start',
      }}
    >
      <div
        data-testid="minimap-toggle"
        className="relative overflow-hidden border border-subtle shadow-[0_8px_24px_-6px_var(--shadow-node)]"
        style={{
          borderRadius: 22,
          transition: 'width 300ms cubic-bezier(0.16,1,0.3,1), height 300ms cubic-bezier(0.16,1,0.3,1), background 200ms ease, backdrop-filter 200ms ease',
          width: minimapOpen ? 220 : 44,
          height: minimapOpen ? 160 : 44,
          background: minimapOpen
            ? 'color-mix(in srgb, var(--surface-2) 45%, transparent)'
            : 'var(--surface-0)',
          backdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
          WebkitBackdropFilter: minimapOpen ? 'blur(24px) saturate(1.5)' : 'none',
        }}
      >
        {minimapOpen && (
          <div className="absolute inset-0">
            <Minimap mode="popover" />
          </div>
        )}
        <button
          type="button"
          onMouseDown={handleMinimapHandleMouseDown}
          onClick={handleMinimapToggleClick}
          title={minimapOpen ? 'Hide minimap (drag to move)' : 'Show minimap (drag to move)'}
          style={{
            WebkitTapHighlightColor: 'transparent',
            position: 'absolute',
            cursor: 'grab',
            ...(mmBottom ? { bottom: -1 } : { top: -1 }),
            ...(mmRight ? { right: -1 } : { left: -1 }),
          }}
          className="w-[44px] h-[44px] flex items-center justify-center text-secondary hover:text-primary active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100 z-10"
        >
          {minimapOpen ? <X size={14} weight="bold" /> : <MapTrifold size={18} />}
        </button>
      </div>
    </div>
    </>
  )
}

export default React.memo(CanvasToolbar)
