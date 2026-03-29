// =============================================================================
// TerminalPanel — thin wrapper around terminalRegistry
//
// Responsibilities:
//   - Call terminalRegistry.getOrCreate() on mount to ensure the terminal and
//     PTY exist (idempotent — returns existing entry if already live).
//   - Call terminalRegistry.attach() to move the xterm DOM into this container.
//   - Own a ResizeObserver that calls fitAddon.fit() whenever the container
//     changes size.
//   - Call terminalRegistry.detach() on unmount — does NOT kill the PTY or
//     dispose anything; the terminal stays live in the registry.
//   - Show an inline search bar on Cmd+F (or Ctrl+F) to search terminal scrollback.
// =============================================================================

import { useEffect, useRef, useState, useCallback } from 'react'
import '@xterm/xterm/css/xterm.css'

import type { TerminalPanelProps } from './types'
import { terminalRegistry } from '../lib/terminalRegistry'
import { useAppStore } from '../stores/appStore'
import { useCanvasStore } from '../stores/canvasStore'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TerminalPanel({
  panelId,
  workspaceId,
  nodeId,
  initialInput,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const rootPath = useAppStore((state) =>
    state.workspaces.find((w) => w.id === workspaceId)?.rootPath,
  )

  const zoomLevel = useCanvasStore((s) => s.zoomLevel)
  const isFocused = useCanvasStore((s) => s.focusedNodeId === nodeId)

  // -------------------------------------------------------------------------
  // Search handlers
  // -------------------------------------------------------------------------

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value)
      if (value) {
        terminalRegistry.findNext(panelId, value)
      } else {
        terminalRegistry.clearSearch(panelId)
      }
    },
    [panelId],
  )

  const handleFindNext = useCallback(() => {
    if (searchQuery) terminalRegistry.findNext(panelId, searchQuery)
  }, [panelId, searchQuery])

  const handleFindPrevious = useCallback(() => {
    if (searchQuery) terminalRegistry.findPrevious(panelId, searchQuery)
  }, [panelId, searchQuery])

  const handleCloseSearch = useCallback(() => {
    setShowSearch(false)
    setSearchQuery('')
    terminalRegistry.clearSearch(panelId)
  }, [panelId])

  // -------------------------------------------------------------------------
  // Keyboard shortcut: Cmd+F / Ctrl+F opens search; Escape closes it
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
      if (e.key === 'Escape' && showSearch) {
        handleCloseSearch()
      }
    }

    const container = containerRef.current
    if (container) {
      container.addEventListener('keydown', handleKeyDown)
      return () => container.removeEventListener('keydown', handleKeyDown)
    }
  }, [panelId, showSearch, handleCloseSearch])

  // -------------------------------------------------------------------------
  // Terminal lifecycle
  // -------------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false

    // 1. Ensure the terminal + PTY exist in the registry (no-op if already live)
    terminalRegistry
      .getOrCreate(panelId, {
        workspaceId,
        cwd: rootPath || undefined,
        initialInput,
      })
      .then((entry) => {
        if (cancelled) return

        // 2. Move the xterm DOM element into this container and fit it
        terminalRegistry.attach(panelId, container)

        // 3. ResizeObserver — keep xterm sized to the container
        //    RAF-gated to prevent multiple fit() calls per frame during drag resize
        let fitPending = false
        const resizeObserver = new ResizeObserver(() => {
          if (fitPending) return
          fitPending = true
          requestAnimationFrame(() => {
            fitPending = false
            try {
              entry.fitAddon.fit()
            } catch {
              // Ignore fit errors during rapid resizing or zero-size frames
            }
          })
        })
        resizeObserver.observe(container)
        resizeObserverRef.current = resizeObserver
      })
      .catch(() => {
        // getOrCreate writes its own error message into the terminal; nothing
        // to do here.
      })

    // Cleanup on unmount: detach DOM, disconnect observer — do NOT kill PTY
    return () => {
      cancelled = true

      terminalRegistry.detach(panelId)

      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
    }
  }, [panelId, workspaceId, nodeId, initialInput, rootPath])

  // -------------------------------------------------------------------------
  // Focus xterm when this node becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isFocused) return
    const entry = terminalRegistry.getEntry(panelId)
    if (!entry) return
    // Small delay to ensure the overlay is removed and xterm can receive focus
    requestAnimationFrame(() => {
      entry.terminal.focus()
    })
  }, [isFocused, panelId])

  // -------------------------------------------------------------------------
  // Re-fit terminal when canvas zoom changes
  // -------------------------------------------------------------------------

  useEffect(() => {
    const entry = terminalRegistry.getEntry(panelId)
    if (!entry) return
    requestAnimationFrame(() => {
      try {
        entry.fitAddon.fit()
      } catch { /* ignore */ }
    })
  }, [panelId, zoomLevel])

  // -------------------------------------------------------------------------
  // Fix mouse coordinates for CSS-scaled canvas
  //
  // xterm.js measures cell dimensions via OffscreenCanvas.measureText() or
  // offsetWidth (both unaffected by CSS transforms), but computes mouse
  // offsets using getBoundingClientRect() (affected by transforms). When the
  // terminal is inside a scale(zoom) container, this mismatch causes text
  // selection to target the wrong row/column. We intercept mouse events in
  // the capture phase and adjust clientX/clientY to cancel out the zoom.
  // -------------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const adjustCoords = (e: MouseEvent) => {
      if (Math.abs(zoomLevel - 1.0) < 0.001) return

      // Find xterm's screen element — the same element xterm uses for its
      // own getBoundingClientRect() call in getCoordsRelativeToElement()
      const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null
      if (!screenEl) return

      const rect = screenEl.getBoundingClientRect()
      // Convert screen-space offset to local (unscaled) offset
      const adjustedX = rect.left + (e.clientX - rect.left) / zoomLevel
      const adjustedY = rect.top + (e.clientY - rect.top) / zoomLevel

      Object.defineProperty(e, 'clientX', { value: adjustedX, configurable: true })
      Object.defineProperty(e, 'clientY', { value: adjustedY, configurable: true })
    }

    // Capture phase runs before xterm's own handlers
    container.addEventListener('mousedown', adjustCoords, { capture: true })
    container.addEventListener('mousemove', adjustCoords, { capture: true })
    container.addEventListener('mouseup', adjustCoords, { capture: true })

    return () => {
      container.removeEventListener('mousedown', adjustCoords, { capture: true })
      container.removeEventListener('mousemove', adjustCoords, { capture: true })
      container.removeEventListener('mouseup', adjustCoords, { capture: true })
    }
  }, [zoomLevel])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="w-full h-full flex flex-col" style={{ padding: 0 }}>
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1 bg-[#28282E] border-b border-white/[0.05] shrink-0">
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.shiftKey ? handleFindPrevious() : handleFindNext()
              }
              if (e.key === 'Escape') handleCloseSearch()
            }}
            className="flex-1 bg-[#1E1E24] text-white text-xs px-2 py-1 rounded border border-white/[0.1] outline-none focus:border-blue-500/50"
            placeholder="Search terminal..."
          />
          <button
            onClick={handleFindPrevious}
            className="text-white/60 hover:text-white/90 text-xs px-1"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={handleFindNext}
            className="text-white/60 hover:text-white/90 text-xs px-1"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            onClick={handleCloseSearch}
            className="text-white/60 hover:text-white/90 text-xs px-1"
            title="Close (Escape)"
          >
            ✕
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1"
        style={{ padding: 0, overflow: 'hidden' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
      />
    </div>
  )
}
