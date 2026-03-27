// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React from 'react'
import { Terminal, Globe, FileText, Minus, Plus } from 'lucide-react'

interface CanvasToolbarProps {
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

const ToolbarButton: React.FC<{
  onClick: () => void
  title: string
  size?: 'panel' | 'zoom'
  children: React.ReactNode
}> = ({ onClick, title, size = 'panel', children }) => {
  const sizeClass = size === 'panel' ? 'w-7 h-7' : 'w-6 h-6'
  return (
    <button
      onClick={onClick}
      title={title}
      className={`${sizeClass} flex items-center justify-center rounded-md hover:bg-white/[0.15] active:bg-white/[0.15] active:scale-[0.92] transition-all duration-100`}
    >
      {children}
    </button>
  )
}

const CanvasToolbar: React.FC<CanvasToolbarProps> = ({
  zoom,
  onNewTerminal,
  onNewBrowser,
  onNewEditor,
  onZoomIn,
  onZoomOut,
}) => {
  const zoomText = `${Math.round(zoom * 100)}%`

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50">
      <div className="flex items-center gap-1 backdrop-blur-xl bg-white/5 border border-white/[0.12] rounded-full shadow-lg px-3 py-1.5">
        {/* New panel buttons */}
        <ToolbarButton onClick={onNewTerminal} title="Terminal" size="panel">
          <Terminal size={16} className="text-white/85" />
        </ToolbarButton>
        <ToolbarButton onClick={onNewBrowser} title="Browser" size="panel">
          <Globe size={16} className="text-white/85" />
        </ToolbarButton>
        <ToolbarButton onClick={onNewEditor} title="Editor" size="panel">
          <FileText size={16} className="text-white/85" />
        </ToolbarButton>

        {/* Divider */}
        <div className="w-px h-5 bg-white/[0.15] mx-1" />

        {/* Zoom controls */}
        <ToolbarButton onClick={onZoomOut} title="Zoom Out" size="zoom">
          <Minus size={14} className="text-white/85" />
        </ToolbarButton>
        <span className="text-xs font-mono text-white/70 min-w-[44px] text-center select-none">
          {zoomText}
        </span>
        <ToolbarButton onClick={onZoomIn} title="Zoom In" size="zoom">
          <Plus size={14} className="text-white/85" />
        </ToolbarButton>
      </div>
    </div>
  )
}

export default React.memo(CanvasToolbar)
