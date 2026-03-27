// =============================================================================
// CanvasToolbar — floating bottom-center toolbar for panel creation and zoom.
// Ported from CanvasToolbar.swift.
// =============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Terminal, Globe, FileText, GitBranch, Minus, Plus, Sparkles, ArrowUp, X } from 'lucide-react'

interface CanvasToolbarProps {
  zoom: number
  onNewTerminal: () => void
  onNewBrowser: () => void
  onNewEditor: () => void
  onNewGit: () => void
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
  onNewGit,
  onZoomIn,
  onZoomOut,
}) => {
  const zoomText = `${Math.round(zoom * 100)}%`
  const [aiExpanded, setAiExpanded] = useState(false)
  const [aiInput, setAiInput] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (aiExpanded) {
      inputRef.current?.focus()
    }
  }, [aiExpanded])

  const handleAiClose = useCallback(() => {
    setAiExpanded(false)
    setAiInput('')
  }, [])

  const handleAiSend = useCallback(() => {
    const text = aiInput.trim()
    if (!text) return
    // TODO: wire up AI chat send
    setAiInput('')
  }, [aiInput])

  // Close on Escape
  useEffect(() => {
    if (!aiExpanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleAiClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [aiExpanded, handleAiClose])

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
        <ToolbarButton onClick={onNewGit} title="Git" size="panel">
          <GitBranch size={16} className="text-white/85" />
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

        {/* Divider */}
        <div className="w-px h-5 bg-white/[0.15] mx-1" />

        {/* AI Chat — sparkles button or expanded input */}
        {!aiExpanded ? (
          <ToolbarButton onClick={() => setAiExpanded(true)} title="AI Chat" size="panel">
            <Sparkles size={16} className="text-white/85" />
          </ToolbarButton>
        ) : (
          <div className="flex items-center gap-1.5 ml-0.5">
            <Sparkles size={14} className="text-white/85 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAiSend() }
              }}
              className="w-[280px] bg-white/[0.08] text-white text-sm px-2.5 py-1 rounded-md border border-white/[0.1] outline-none focus:border-purple-500/50 placeholder:text-white/30"
              placeholder="Ask AI anything..."
            />
            <button
              onClick={handleAiSend}
              disabled={!aiInput.trim()}
              title="Send"
              className="w-6 h-6 flex items-center justify-center rounded-md bg-purple-500/30 hover:bg-purple-500/40 disabled:opacity-30 transition-all duration-100"
            >
              <ArrowUp size={13} className="text-white/90" />
            </button>
            <button
              onClick={handleAiClose}
              title="Close"
              className="w-5 h-5 flex items-center justify-center rounded-md hover:bg-white/[0.15] transition-all duration-100"
            >
              <X size={12} className="text-white/50" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default React.memo(CanvasToolbar)
