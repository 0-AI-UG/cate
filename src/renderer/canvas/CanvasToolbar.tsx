// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import {
  Terminal,
  Globe,
  FileText,
  Minus,
  Plus,
  Square,
  ArrowsOutSimple,
  DotsThree,
  SquaresFour,
  MapTrifold,
  Cursor,
  Hand,
  X,
} from '@phosphor-icons/react'
import { CateLogo } from '../ui/CateLogo'
import Minimap from './Minimap'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useUIStore } from '../stores/uiStore'
import { useShortcutStore } from '../stores/shortcutStore'
import { displayString, PANEL_DEFAULT_SIZES } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { UpdateButton } from './UpdateButton'

// The minimap pill can be docked in any of the four canvas corners. The choice
// persists across sessions in localStorage.
type MinimapCorner = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
const MINIMAP_CORNER_KEY = 'cate.minimapButton.corner'
const loadMinimapCorner = (): MinimapCorner => {
  try {
    const v = localStorage.getItem(MINIMAP_CORNER_KEY)
    if (v === 'bottom-right' || v === 'bottom-left' || v === 'top-right' || v === 'top-left') {
      return v
    }
  } catch {}
  return 'bottom-right'
}

interface CanvasToolbarProps {
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onNewAgent: () => void
  onNewCanvas: () => void
  onNewRegion: () => void
  onAutoLayout: () => void
  onZoomToFit: () => void
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
    <button
      type="button"
      onClick={onClick}
      onMouseDown={onMouseDown}
      title={title}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      className={`${sizeClass} ${activeClass} flex items-center justify-center rounded-full text-secondary hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
    >
      {children}
    </button>
  )
}

// Terminal button with drag-to-place: a plain click opens the recommendation
// picker (onClick), while dragging onto the canvas spawns a ghost that follows
// the cursor and drops a terminal at that exact spot (explicit position →
// bypasses the picker). The cursor is treated as the new terminal's centre.
const TerminalSpawnButton: React.FC<{ onClick: () => void }> = ({ onClick }) => {
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
      if (wsId) useAppStore.getState().createTerminal(wsId, undefined, pos)
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
        title="Terminal — click for recommendations, or drag onto the canvas"
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

// A tool-mode button with an always-on corner key badge that fills when active.
const ModeButton: React.FC<{
  onClick: () => void
  title: string
  active: boolean
  badge: string
  children: React.ReactNode
}> = ({ onClick, title, active, badge, children }) => {
  const activeClass = active ? 'bg-hover-strong' : 'bg-transparent'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      className={`group relative w-9 h-9 ${activeClass} flex items-center justify-center rounded-full ${active ? 'text-primary' : 'text-secondary'} hover:text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
    >
      {children}
      <span
        className="absolute bottom-0 right-0.5 font-mono leading-none pointer-events-none select-none opacity-0 group-hover:opacity-100 transition-opacity duration-100"
        style={{ fontSize: 7, color: 'var(--text-muted)' }}
      >
        {badge}
      </span>
    </button>
  )
}

const MenuItem: React.FC<{
  onClick: () => void
  icon: React.ReactNode
  label: string
}> = ({ onClick, icon, label }) => (
  <button
    type="button"
    onClick={onClick}
    style={{ WebkitTapHighlightColor: 'transparent' }}
    className="group w-full flex items-center justify-between gap-3 px-2.5 py-1 rounded-md text-left text-[13px] text-primary bg-transparent hover:bg-focus-blue hover:text-inverse focus:outline-none focus-visible:outline-none transition-colors"
  >
    <span>{label}</span>
    <span className="w-4 h-4 flex items-center justify-center opacity-80 group-hover:opacity-100">{icon}</span>
  </button>
)

const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  zoom,
  onNewTerminal,
  onNewBrowser,
  onNewEditor,
  onNewAgent,
  onNewCanvas,
  onNewRegion,
  onAutoLayout,
  onZoomToFit,
  onZoomIn,
  onZoomOut,
}) => {
  const canvasApi = useCanvasStoreApi()
  const minimapOpen = useUIStore((s) => s.minimapOpen)
  const toggleMinimapOpen = useUIStore((s) => s.toggleMinimapOpen)
  const activeTool = useUIStore((s) => s.activeTool)
  const setActiveTool = useUIStore((s) => s.setActiveTool)
  const selectKey = useShortcutStore((s) => displayString(s.shortcuts.toolSelect))
  const handKey = useShortcutStore((s) => displayString(s.shortcuts.toolHand))
  const zoomText = `${Math.round(zoom * 100)}%`

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Minimap pill docking corner + drag-to-dock handling. The toggle button
  // doubles as a drag handle: a click toggles the map, a drag past a small
  // threshold re-docks the pill to whichever corner the cursor ends up in.
  const [minimapCorner, setMinimapCorner] = useState<MinimapCorner>(loadMinimapCorner)
  const minimapDidDragRef = useRef(false)
  const mmBottom = minimapCorner.startsWith('bottom')
  const mmRight = minimapCorner.endsWith('right')

  const handleMinimapHandleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    minimapDidDragRef.current = false
    let nextCorner = minimapCorner
    const onMove = (ev: MouseEvent) => {
      if (!minimapDidDragRef.current && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) {
        return
      }
      minimapDidDragRef.current = true
      const right = ev.clientX > window.innerWidth / 2
      const bottom = ev.clientY > window.innerHeight / 2
      nextCorner = `${bottom ? 'bottom' : 'top'}-${right ? 'right' : 'left'}` as MinimapCorner
      setMinimapCorner((prev) => (prev === nextCorner ? prev : nextCorner))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (minimapDidDragRef.current) {
        try { localStorage.setItem(MINIMAP_CORNER_KEY, nextCorner) } catch {}
      }
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

  // Close drop-up on outside click / Escape
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const pick = (fn: () => void) => () => {
    fn()
    setMenuOpen(false)
  }

  return (
    <>
    <div
      className="absolute bottom-4 z-50 flex justify-center pointer-events-none"
      style={{
        left: 'var(--cate-left-sidebar-width, 0px)',
        right: 'var(--cate-right-sidebar-width, 0px)',
      }}
    >
      <div ref={menuRef} data-onboarding="toolbar" className="relative pointer-events-auto">
        {/* Drop-up menu */}
        {menuOpen && (
          <div
            data-theme="dark-warm"
            className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 min-w-[200px] rounded-lg border border-subtle bg-surface-4/95 backdrop-blur-xl backdrop-saturate-150 shadow-[0_10px_30px_-10px_var(--shadow-node)] p-1"
          >
            <MenuItem
              onClick={pick(onNewRegion)}
              icon={<Square size={16} />}
              label="New Region"
            />
            <div className="h-px bg-surface-5 my-1" />
            <MenuItem
              onClick={pick(onAutoLayout)}
              icon={<SquaresFour size={16} />}
              label="Auto Layout"
            />
            <MenuItem
              onClick={pick(onZoomToFit)}
              icon={<ArrowsOutSimple size={16} />}
              label="Zoom to Fit"
            />
          </div>
        )}

        <div className="rounded-full border border-subtle bg-surface-0 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-0.5 px-1 py-1">
            {/* Interaction tools (Select / Hand) */}
            <ModeButton
              onClick={() => setActiveTool('select')}
              title={`Select tool (${selectKey})`}
              active={activeTool === 'select'}
              badge={selectKey}
            >
              <Cursor size={18} />
            </ModeButton>
            <ModeButton
              onClick={() => setActiveTool('hand')}
              title={`Hand tool — pan (${handKey})`}
              active={activeTool === 'hand'}
              badge={handKey}
            >
              <Hand size={18} />
            </ModeButton>

            {/* Divider */}
            <div className="w-px h-5 bg-surface-5 mx-1" />

            {/* Basic panel buttons */}
            <TerminalSpawnButton onClick={onNewTerminal} />
            <ToolbarButton onClick={onNewBrowser} title="Browser" size="panel">
              <Globe size={18} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewEditor} title="Editor" size="panel">
              <FileText size={18} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewAgent} title="Pi Agent" size="panel">
              <CateLogo size={18} />
            </ToolbarButton>

            {/* Divider */}
            <div className="w-px h-5 bg-surface-5 mx-1" />

            {/* More — opens drop-up with extra creators */}
            <ToolbarButton
              onClick={() => setMenuOpen((v) => !v)}
              title="More…"
              size="panel"
              active={menuOpen}
            >
              <DotsThree size={18} />
            </ToolbarButton>

            {/* Zoom controls */}
            <ToolbarButton onClick={onZoomOut} title="Zoom Out" size="zoom">
              <Minus size={16} />
            </ToolbarButton>
            <button
              type="button"
              onClick={() => canvasApi.getState().animateZoomTo(1.0)}
              title="Reset zoom to 100%"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              className="text-[11px] font-mono text-secondary hover:text-primary min-w-[40px] text-center select-none rounded-full bg-transparent hover:bg-hover-strong active:bg-hover-strong cursor-pointer px-1.5 py-1 focus:outline-none focus-visible:outline-none transition-all duration-100"
            >
              {zoomText}
            </button>
            <ToolbarButton onClick={onZoomIn} title="Zoom In" size="zoom">
              <Plus size={16} />
            </ToolbarButton>
          </div>
        </div>
      </div>

    </div>

    {/* Minimap — pill button docked to any corner. The pill grows toward the
        canvas centre to reveal the map, while the toggle button stays pinned to
        the docked corner so open and close feel like the same gesture. Drag the
        button to re-dock the pill to a different corner. */}
    <div
      className="absolute z-50 flex gap-2"
      style={{
        ...(mmBottom ? { bottom: '1rem' } : { top: '1rem' }),
        ...(mmRight
          ? { right: 'calc(1rem + var(--cate-right-sidebar-width, 0px))' }
          : { left: 'calc(1rem + var(--cate-left-sidebar-width, 0px))' }),
        // Keep the pill hard against the docked corner; the UpdateButton sits inboard.
        flexDirection: mmRight ? 'row' : 'row-reverse',
        alignItems: mmBottom ? 'flex-end' : 'flex-start',
      }}
    >
      <UpdateButton />
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
