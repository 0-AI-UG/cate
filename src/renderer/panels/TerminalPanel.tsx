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

// Base xterm font size — must match the value used in terminalRegistry.ts when
// creating the Terminal. We re-rasterize at BASE_FONT_SIZE * renderScale when
// the canvas zooms in, so glyph atlases stay crisp instead of being CSS-upscaled.
const BASE_FONT_SIZE = 13

// Discrete render-scale steps. We snap canvas zoom to one of these so a
// continuous pinch only triggers a small number of expensive atlas rebuilds.
// Capped at 2.5× — beyond that, atlas memory grows without perceptible gain.
const RENDER_SCALE_STEPS: number[] = [1.0, 1.5, 2.0, 2.5]

function snapRenderScale(zoom: number): number {
  if (zoom <= 1.0) return 1.0
  let best = RENDER_SCALE_STEPS[0]
  let bestDist = Math.abs(zoom - best)
  for (const step of RENDER_SCALE_STEPS) {
    const d = Math.abs(zoom - step)
    if (d < bestDist) {
      best = step
      bestDist = d
    }
  }
  // For zoom above the top step, just use the top step.
  if (zoom > RENDER_SCALE_STEPS[RENDER_SCALE_STEPS.length - 1]) {
    return RENDER_SCALE_STEPS[RENDER_SCALE_STEPS.length - 1]
  }
  return best
}

export default function TerminalPanel({
  panelId,
  workspaceId,
  nodeId,
  initialInput,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderBoxRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const fitRafRef = useRef<number | null>(null)
  const [renderScale, setRenderScale] = useState(1.0)

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
    const renderBox = renderBoxRef.current
    if (!renderBox) return

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

        // 2. Move the xterm DOM element into the render box and fit it
        terminalRegistry.attach(panelId, renderBox)

        // 3. ResizeObserver — keep xterm sized to the render box
        //    Debounced to avoid expensive fit() calls during rapid resize (e.g. node drag).
        const resizeObserver = new ResizeObserver(() => {
          if (fitRafRef.current !== null) cancelAnimationFrame(fitRafRef.current)
          fitRafRef.current = requestAnimationFrame(() => {
            fitRafRef.current = null
            try {
              const viewport = entry.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
              const wasAtBottom = viewport
                ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
                : true

              terminalRegistry.fit(panelId)

              if (wasAtBottom) {
                entry.terminal.scrollToBottom()
              }
            } catch {
              // Ignore fit errors during rapid resizing or zero-size frames
            }
          })
        })
        resizeObserver.observe(renderBox)
        resizeObserverRef.current = resizeObserver
      })
      .catch(() => {
        // getOrCreate writes its own error message into the terminal; nothing
        // to do here.
      })

    // Cleanup on unmount: detach DOM, disconnect observer — do NOT kill PTY
    return () => {
      cancelled = true

      // Cancel pending fit RAF to prevent fit() on a disposed entry
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = null
      }

      terminalRegistry.detach(panelId, renderBox)

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

    const textarea = entry.terminal.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    if (textarea) {
      textarea.focus({ preventScroll: true })
    } else {
      entry.terminal.focus()
    }

    // Restore scroll position from the continuously-tracked value in the
    // registry. This survives any scroll resets that may have happened
    // between losing and regaining focus.
    terminalRegistry.restoreScroll(panelId)
    requestAnimationFrame(() => terminalRegistry.restoreScroll(panelId))
  }, [isFocused, panelId])

  // -------------------------------------------------------------------------
  // Crisp rendering at high canvas zoom
  //
  // The canvas applies a single scale(zoom) transform to the world div. That
  // CSS-upscales xterm's pre-rasterized glyph atlas, which looks pixelated at
  // zoom > 1. To stay sharp we mimic VS Code's webFrame-zoom trick: when zoom
  // settles on a higher step, we bump xterm's fontSize to BASE * renderScale
  // (forcing a fresh higher-resolution atlas) and counter-scale the render
  // box by 1/renderScale so the on-screen size — after the world div's outer
  // scale(zoom) — is unchanged. Cols × rows stay constant because both the
  // box and the cell grow by the same factor before fit() runs.
  //
  // Waits 2 idle animation frames after the last zoom change so a continuous
  // pinch only rebuilds the atlas at gesture end (each rebuild is expensive).
  // -------------------------------------------------------------------------

  const rescaleRafRef = useRef<number | null>(null)
  useEffect(() => {
    const target = snapRenderScale(zoomLevel)
    if (target === renderScale) return
    if (rescaleRafRef.current !== null) cancelAnimationFrame(rescaleRafRef.current)
    const capturedZoom = zoomLevel
    rescaleRafRef.current = requestAnimationFrame(() => {
      rescaleRafRef.current = requestAnimationFrame(() => {
        rescaleRafRef.current = null
        if (snapRenderScale(capturedZoom) === target) setRenderScale(target)
      })
    })
    return () => {
      if (rescaleRafRef.current !== null) {
        cancelAnimationFrame(rescaleRafRef.current)
        rescaleRafRef.current = null
      }
    }
  }, [zoomLevel, renderScale])

  useEffect(() => {
    const renderBox = renderBoxRef.current
    if (!renderBox) return
    // Skip rebuilds when the panel is offscreen / hidden — cheap and avoids
    // burning GPU on terminals the user can't see.
    if (renderBox.offsetParent === null) return
    const rect = renderBox.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const entry = terminalRegistry.getEntry(panelId)
    if (!entry) return

    try {
      const viewport = entry.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
      const wasAtBottom = viewport
        ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
        : true

      // Mutating options.fontSize triggers xterm's internal renderer refresh,
      // which rebuilds the WebGL glyph atlas at the new resolution.
      entry.terminal.options.fontSize = BASE_FONT_SIZE * renderScale
      terminalRegistry.fit(panelId)

      if (wasAtBottom) entry.terminal.scrollToBottom()
    } catch {
      // Ignore — fit can throw on zero-size frames during layout transitions.
    }
  }, [renderScale, panelId])

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

    // The full transform chain on .xterm-screen is:
    //   inner render box: scale(1/renderScale)   (counter-scale, see effect above)
    //   outer world div : scale(zoomLevel)
    // so screen pixels = DOM pixels × (zoomLevel / renderScale).
    // xterm computes hit-testing against its own DOM-space cell metrics, so we
    // must convert the incoming screen-space offset back into DOM space.
    const adjustCoords = (e: MouseEvent) => {
      const effective = zoomLevel / renderScale
      if (Math.abs(effective - 1.0) < 0.001) return

      // Find xterm's screen element — the same element xterm uses for its
      // own getBoundingClientRect() call in getCoordsRelativeToElement()
      const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null
      if (!screenEl) return

      const rect = screenEl.getBoundingClientRect()
      // Convert screen-space offset to local (DOM-space) offset
      const adjustedX = rect.left + (e.clientX - rect.left) / effective
      const adjustedY = rect.top + (e.clientY - rect.top) / effective

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
  }, [zoomLevel, renderScale])

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
        <div className="flex items-center gap-1 px-2 py-1 bg-[#1a1917] border-b border-white/[0.05] shrink-0">
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
            className="flex-1 bg-[#1f1e1c] text-white text-xs px-2 py-1 rounded border border-white/[0.1] outline-none focus:border-blue-500/50"
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
        {/*
          Render box: counter-scaled by 1/renderScale so that xterm renders
          into a virtual area renderScale× larger in DOM pixels (and at a
          renderScale× larger fontSize), then is shrunk back to fill the
          actual panel before the world div applies its outer scale(zoom).
          The net visual size is unchanged, but glyphs come from a higher-
          resolution atlas.
        */}
        <div
          ref={renderBoxRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${100 * renderScale}%`,
            height: `${100 * renderScale}%`,
            transform: `scale(${1 / renderScale})`,
            transformOrigin: '0 0',
          }}
        />
        {isDragOver && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/10 border-2 border-dashed border-blue-500/40 rounded pointer-events-none">
            <span className="text-blue-400 text-sm font-medium">Drop to paste path</span>
          </div>
        )}
      </div>
    </div>
  )
}
