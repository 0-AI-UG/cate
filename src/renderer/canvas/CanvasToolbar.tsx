// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React, { useState, useRef, useEffect } from 'react'
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
} from '@phosphor-icons/react'
import Minimap from './Minimap'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { useSettingsStore } from '../stores/settingsStore'
import { UpdateButton } from './UpdateButton'

interface CanvasToolbarProps {
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
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
  children: React.ReactNode
}> = ({ onClick, title, size = 'panel', active = false, children }) => {
  const sizeClass = size === 'panel' ? 'w-7 h-7' : 'w-6 h-6'
  const activeClass = active ? 'bg-hover-strong' : 'bg-transparent'
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{ WebkitTapHighlightColor: 'transparent' }}
      className={`${sizeClass} ${activeClass} flex items-center justify-center rounded-full text-primary hover:bg-hover-strong active:bg-hover-strong active:scale-[0.92] focus:outline-none focus-visible:outline-none transition-all duration-100`}
    >
      {children}
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
  onNewCanvas,
  onNewRegion,
  onAutoLayout,
  onZoomToFit,
  onZoomIn,
  onZoomOut,
}) => {
  const canvasApi = useCanvasStoreApi()
  const showMinimap = useSettingsStore((s) => s.showMinimap)
  const saveSetting = useSettingsStore((s) => s.saveSetting)
  const zoomText = `${Math.round(zoom * 100)}%`

  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

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
      <div ref={menuRef} className="relative pointer-events-auto">
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

        <div className="rounded-full border border-strong bg-surface-6 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center gap-1 px-3 py-1.5">
            {/* Basic panel buttons */}
            <ToolbarButton onClick={onNewTerminal} title="Terminal" size="panel">
              <Terminal size={14} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewBrowser} title="Browser" size="panel">
              <Globe size={14} />
            </ToolbarButton>
            <ToolbarButton onClick={onNewEditor} title="Editor" size="panel">
              <FileText size={14} />
            </ToolbarButton>

            {/* Divider */}
            <div className="w-px h-4 bg-surface-5 mx-0.5" />

            {/* More — opens drop-up with extra creators */}
            <ToolbarButton
              onClick={() => setMenuOpen((v) => !v)}
              title="More…"
              size="panel"
              active={menuOpen}
            >
              <DotsThree size={14} />
            </ToolbarButton>

            {/* Zoom controls */}
            <ToolbarButton onClick={onZoomOut} title="Zoom Out" size="zoom">
              <Minus size={12} />
            </ToolbarButton>
            <button
              type="button"
              onClick={() => canvasApi.getState().animateZoomTo(1.0)}
              title="Reset zoom to 100%"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              className="text-[10px] font-mono text-primary min-w-[38px] text-center select-none rounded-full bg-transparent hover:bg-hover-strong active:bg-hover-strong cursor-pointer px-1 py-0.5 focus:outline-none focus-visible:outline-none transition-all duration-100"
            >
              {zoomText}
            </button>
            <ToolbarButton onClick={onZoomIn} title="Zoom In" size="zoom">
              <Plus size={12} />
            </ToolbarButton>
          </div>
        </div>
      </div>

    </div>

    {/* Minimap — standalone pill button anchored to the bottom-right corner.
        The right offset includes the right sidebar width so the button stays
        visible when the overlay sidebar is expanded. */}
    <div
      className="absolute bottom-4 z-50 flex items-center gap-2"
      style={{ right: 'calc(1rem + var(--cate-right-sidebar-width, 0px))' }}
    >
      <UpdateButton />
      <div className="relative">
        <div className="rounded-full border border-strong bg-surface-6 shadow-[0_8px_24px_-6px_var(--shadow-node)]">
          <div className="flex items-center p-1.5">
            <ToolbarButton
              onClick={() => saveSetting('showMinimap', !showMinimap)}
              title={showMinimap ? 'Hide minimap' : 'Show minimap'}
              size="panel"
              active={showMinimap}
            >
              <MapTrifold size={14} />
            </ToolbarButton>
          </div>
        </div>
        {showMinimap && (
          <div
            data-theme="dark-warm"
            className="absolute right-0 bottom-full mb-2 rounded-lg overflow-hidden shadow-[0_18px_40px_-12px_var(--shadow-node)]"
          >
            <Minimap mode="popover" />
          </div>
        )}
        {showMinimap && (
          <>
            {/* Border triangle (slightly larger, underneath) */}
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2 bottom-full"
              style={{
                marginBottom: 1,
                width: 0,
                height: 0,
                borderLeft: '7px solid transparent',
                borderRight: '7px solid transparent',
                borderTop: '7px solid var(--border-subtle)',
              }}
            />
            {/* Fill triangle (on top, 1px inset) */}
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2 bottom-full"
              style={{
                marginBottom: 2,
                width: 0,
                height: 0,
                borderLeft: '6px solid transparent',
                borderRight: '6px solid transparent',
                borderTop: '6px solid var(--surface-2)',
              }}
            />
            {/* Notch — covers the 1px popover border across the tail's width so
                the tail visually connects to the popover without a seam line. */}
            <div
              aria-hidden
              className="absolute left-1/2 -translate-x-1/2 bottom-full"
              style={{
                marginBottom: 8,
                width: 12,
                height: 1,
                background: 'var(--surface-2)',
              }}
            />
          </>
        )}
      </div>
    </div>
    </>
  )
}

export default React.memo(CanvasToolbar)
