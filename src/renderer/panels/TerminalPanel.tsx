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
import { useCanvasStoreContext } from '../stores/CanvasStoreContext'

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
  const fitTimeoutRef = useRef<(() => void) | null>(null)

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const rootPath = useAppStore((state) =>
    state.workspaces.find((w) => w.id === workspaceId)?.rootPath,
  )
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)
  const zoomLevel = useCanvasStoreContext((s) => s.zoomLevel)

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

  const showSearchRef = useRef(showSearch)
  showSearchRef.current = showSearch
  const handleCloseSearchRef = useRef(handleCloseSearch)
  handleCloseSearchRef.current = handleCloseSearch

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setShowSearch(true)
      }
      if (e.key === 'Escape' && showSearchRef.current) {
        handleCloseSearchRef.current()
      }
    }

    const container = containerRef.current
    if (container) {
      container.addEventListener('keydown', handleKeyDown)
      return () => container.removeEventListener('keydown', handleKeyDown)
    }
  }, [panelId])

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
        cwd: rootPathRef.current || undefined,
        initialInput,
      })
      .then((entry) => {
        if (cancelled) return

        // 2. Move the xterm DOM element into this container and fit it
        terminalRegistry.attach(panelId, container)

        // 3. ResizeObserver — keep xterm sized to the container
        //    Debounced to avoid expensive fit() calls during rapid resize (e.g. node drag).
        let fitTimeoutId = 0
        const resizeObserver = new ResizeObserver(() => {
          clearTimeout(fitTimeoutId)
          fitTimeoutId = window.setTimeout(() => {
            try {
              const viewport = entry.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
              const wasAtBottom = viewport
                ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
                : true

              entry.fitAddon.fit()

              if (wasAtBottom) {
                entry.terminal.scrollToBottom()
              }
            } catch {
              // Ignore fit errors during rapid resizing or zero-size frames
            }
          }, 50)
        })
        resizeObserver.observe(container)
        resizeObserverRef.current = resizeObserver
        fitTimeoutRef.current = () => clearTimeout(fitTimeoutId)
      })
      .catch(() => {
        // getOrCreate writes its own error message into the terminal; nothing
        // to do here.
      })

    // Cleanup on unmount: detach DOM, disconnect observer — do NOT kill PTY
    return () => {
      cancelled = true

      // Clear pending fit timeout to prevent fit() on a disposed entry
      if (fitTimeoutRef.current) {
        fitTimeoutRef.current()
        fitTimeoutRef.current = null
      }

      terminalRegistry.detach(panelId, container)

      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
    }
  }, [panelId, workspaceId, nodeId, initialInput])

  // -------------------------------------------------------------------------
  // Focus xterm when this node becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!isFocused) return
    const entry = terminalRegistry.getEntry(panelId)
    if (!entry) return

    // Save the xterm viewport scroll position before focusing — the browser
    // can reset .xterm-viewport.scrollTop during focus mechanics even with
    // preventScroll.
    const viewport = entry.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
    const savedScrollTop = viewport?.scrollTop ?? null

    const textarea = entry.terminal.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.focus({ preventScroll: true })
    } else {
      entry.terminal.focus()
    }

    // Restore scroll position after the browser's focus-triggered scroll
    if (viewport && savedScrollTop !== null) {
      requestAnimationFrame(() => {
        viewport.scrollTop = savedScrollTop
      })
    }
  }, [isFocused, panelId])

  // NOTE: No separate zoom-level re-fit needed — zoom only changes the CSS
  // transform, not the container size. The ResizeObserver handles actual resizes.

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
  // Drag-and-drop: accept files from OS or internal file explorer
  // -------------------------------------------------------------------------

  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Accept drops from internal file explorer or external file drops
    if (
      e.dataTransfer.types.includes('application/cate-file') ||
      e.dataTransfer.types.includes('Files')
    ) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setIsDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when leaving the container itself, not child elements
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      setIsDragOver(false)

      const paths: string[] = []

      // Internal file explorer drag
      const catePath = e.dataTransfer.getData('application/cate-file')
      if (catePath) {
        paths.push(catePath)
      }

      // External OS file drop — use Electron's webUtils to get real paths
      if (e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          const filePath = window.electronAPI?.getPathForFile(file)
          if (filePath) paths.push(filePath)
        }
      }

      if (paths.length === 0) return

      // Shell-escape each path and write to terminal as space-separated text
      const escaped = paths.map((p) => {
        // If path contains no special shell characters, use it as-is
        if (/^[a-zA-Z0-9_./:@~=-]+$/.test(p)) return p
        // Otherwise, single-quote it (escaping any existing single quotes)
        return "'" + p.replace(/'/g, "'\\''") + "'"
      })

      const entry = terminalRegistry.getEntry(panelId)
      if (entry) {
        entry.terminal.paste(escaped.join(' '))
      }
    },
    [panelId],
  )

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
        className="flex-1 relative min-h-0"
        style={{ padding: 0, overflow: 'hidden' }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded pointer-events-none">
            <span className="text-blue-400 text-sm font-medium">Drop to paste path</span>
          </div>
        )}
      </div>
    </div>
  )
}
