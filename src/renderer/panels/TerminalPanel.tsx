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

import type { TerminalPanelProps } from './types'
import { terminalRegistry } from '../lib/terminal/terminalRegistry'
import { formatTerminalPaste, type DroppedRef } from './terminalDrop'
import { useAppStore } from '../stores/appStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useCanvasStoreContext, useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { resolveTerminalFontSize } from '../lib/terminal/terminalSettings'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFitSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [renderScale, setRenderScale] = useState(1.0)
  const terminalBaseFontSize = useSettingsStore((state) =>
    resolveTerminalFontSize(state.terminalFontSize),
  )

  const [showSearch, setShowSearch] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  // Bumping this re-runs the create effect — used by the Retry button after
  // a terminal create failure (issue #39).
  const [retryKey, setRetryKey] = useState(0)
  const [createError, setCreateError] = useState<string | null>(() =>
    terminalRegistry.getFailure(panelId),
  )

  // Subscribe to create-failure changes for this panel so the Retry overlay
  // appears (and disappears) without polling.
  useEffect(() => {
    setCreateError(terminalRegistry.getFailure(panelId))
    const unsubscribe = terminalRegistry.subscribeFailure((id) => {
      if (id === panelId) setCreateError(terminalRegistry.getFailure(panelId))
    })
    return unsubscribe
  }, [panelId])

  const handleRetry = useCallback(() => {
    setCreateError(null)
    setRetryKey((k) => k + 1)
  }, [])

  const workspaces = useAppStore((state) => state.workspaces)
  const panelCwd = useAppStore(
    (state) => state.workspaces.find((w) => w.id === workspaceId)?.panels[panelId]?.cwd,
  )
  // Bumped by respawnPanelTerminal() to force a fresh PTY at a new cwd (worktree
  // switch). Folded into the lifecycle effect deps below so it re-creates.
  const ptyEpoch = useAppStore(
    (state) => state.workspaces.find((w) => w.id === workspaceId)?.panels[panelId]?.ptyEpoch ?? 0,
  )
  const workspaceRoot = workspaces.find((w) => w.id === workspaceId)?.rootPath
  // Prefer an explicit per-panel cwd (drag-drop folder, worktree, etc.).
  const rootPath = panelCwd || workspaceRoot
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  const isFocused = useCanvasStoreContext((s) => s.focusedNodeId === nodeId)
  const canvasApi = useCanvasStoreApi()
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

    function attachAndObserve(entry: import('../lib/terminal/terminalRegistry').RegistryEntry): void {
      if (cancelled) return

      // Move the xterm DOM element into the render box and fit it
      terminalRegistry.attach(panelId, renderBox!)

      // ResizeObserver — keep xterm sized to the render box.
      //
      // Two layers of gating to avoid the fit() storm a zoom gesture would
      // otherwise produce (every transform tick fires layout, which fires the
      // observer):
      //   1. Skip the callback entirely if clientWidth/clientHeight hasn't
      //      changed by more than 0.5 px since the last accepted fit. Pure
      //      transform changes (canvas pan/zoom) leave clientWidth alone, so
      //      this short-circuits before we touch xterm.
      //   2. Debounce to a ~32 ms trailing edge so a continuous gesture
      //      coalesces into one fit() at gesture end. After fit(), compare
      //      cols/rows to before — if unchanged, the cleanup path skips the
      //      scrollToBottom dance so we don't perturb the viewport.
      const DEBOUNCE_MS = 32
      const RESIZE_EPSILON = 0.5

      const runFit = () => {
        fitTimerRef.current = null
        if (!renderBox) return
        // Defer fitting while a canvas gesture (panel resize / pan / zoom) is in
        // flight. Fitting mid-gesture calls terminal.resize() every tick, which
        // re-sizes the WebGL canvas and makes the panel edge appear to "jump"
        // (terminals only — editors don't resize a GPU canvas). useNodeResize
        // and the wheel-pan both hold `canvas-interacting` for the gesture's
        // duration, so re-check on the same cadence and fit once it settles.
        if (document.body.classList.contains('canvas-interacting')) {
          fitTimerRef.current = setTimeout(() => {
            fitRafRef.current = requestAnimationFrame(runFit)
          }, DEBOUNCE_MS)
          return
        }
        const w = renderBox.clientWidth
        const h = renderBox.clientHeight
        if (w === 0 || h === 0) return
        if (
          Math.abs(w - lastFitSizeRef.current.w) < RESIZE_EPSILON &&
          Math.abs(h - lastFitSizeRef.current.h) < RESIZE_EPSILON
        ) {
          return
        }
        lastFitSizeRef.current = { w, h }
        try {
          const viewport = entry.terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
          const wasAtBottom = viewport
            ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
            : true
          const prevCols = entry.terminal.cols
          const prevRows = entry.terminal.rows

          terminalRegistry.fit(panelId)

          // Only re-pin scroll if the grid actually changed; an unchanged
          // fit() shouldn't disturb the user's scroll position.
          if (
            wasAtBottom
            && (entry.terminal.cols !== prevCols || entry.terminal.rows !== prevRows)
          ) {
            entry.terminal.scrollToBottom()
          }
        } catch {
          // Ignore fit errors during rapid resizing or zero-size frames
        }
      }

      const scheduleFit = () => {
        if (!renderBox) return
        const w = renderBox.clientWidth
        const h = renderBox.clientHeight
        // Cheap early-out: dimensions haven't actually changed (this fires
        // a lot during canvas transforms).
        if (
          Math.abs(w - lastFitSizeRef.current.w) < RESIZE_EPSILON &&
          Math.abs(h - lastFitSizeRef.current.h) < RESIZE_EPSILON
        ) {
          return
        }
        if (fitTimerRef.current !== null) clearTimeout(fitTimerRef.current)
        if (fitRafRef.current !== null) {
          cancelAnimationFrame(fitRafRef.current)
          fitRafRef.current = null
        }
        fitTimerRef.current = setTimeout(() => {
          fitRafRef.current = requestAnimationFrame(() => {
            fitRafRef.current = null
            runFit()
          })
        }, DEBOUNCE_MS)
      }

      const resizeObserver = new ResizeObserver(scheduleFit)
      resizeObserver.observe(renderBox!)
      resizeObserverRef.current = resizeObserver
    }

    function detachAndDisconnect(): void {
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current)
        fitRafRef.current = null
      }
      if (fitTimerRef.current !== null) {
        clearTimeout(fitTimerRef.current)
        fitTimerRef.current = null
      }
      terminalRegistry.detach(panelId, renderBox!)
      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
    }

    // 1. Ensure the terminal + PTY exist in the registry (no-op if already live)
    terminalRegistry
      .getOrCreate(panelId, {
        workspaceId,
        cwd: rootPathRef.current || undefined,
        initialInput,
      })
      .then((entry) => {
        if (cancelled) return
        attachAndObserve(entry)

        // IntersectionObserver: detach WebGL/ResizeObserver when hidden, re-attach when visible.
        // Also notify main so it can SIGSTOP the PTY after it has been hidden + silent
        // for IDLE_SUSPEND_MS (see src/main/ipc/terminal.ts).
        const intersectionObserver = new IntersectionObserver(
          (entries) => {
            if (cancelled) return
            const isVisible = entries[0]?.isIntersecting ?? false
            if (isVisible) {
              if (!resizeObserverRef.current) {
                attachAndObserve(entry)
              }
            } else {
              detachAndDisconnect()
            }
            if (entry.ptyId) {
              window.electronAPI.terminalSetVisibility(entry.ptyId, isVisible).catch(() => { /* noop */ })
            }
          },
          { threshold: 0 },
        )
        intersectionObserver.observe(renderBox!)
        ;(renderBox as any).__intersectionObserver = intersectionObserver
      })
      .catch(() => {
        // getOrCreate writes its own error message into the terminal; nothing
        // to do here.
      })

    // Cleanup on unmount: detach DOM, disconnect observer — do NOT kill PTY
    return () => {
      cancelled = true

      const io = (renderBox as any).__intersectionObserver as IntersectionObserver | undefined
      if (io) {
        io.disconnect()
        delete (renderBox as any).__intersectionObserver
      }

      detachAndDisconnect()
    }
  }, [panelId, workspaceId, nodeId, initialInput, retryKey, ptyEpoch])

  // -------------------------------------------------------------------------
  // Focus xterm when this node becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    const runFocus = () => {
      let waitAttempts = 0
      let recheckAttempts = 0
      let scrollRestored = false
      let myCancelled = false
      const tick = () => {
        if (cancelled || myCancelled) return
        const entry = terminalRegistry.getEntry(panelId)
        const el = entry?.terminal.element
        // Skip when xterm DOM is not attached: IntersectionObserver can briefly
        // detach the element during mount on a virtualized panel just brought
        // into view via the minimap.
        if (!entry || !el || !el.isConnected) {
          if (waitAttempts++ < 80) setTimeout(tick, 25)
          return
        }
        const textarea = el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        const target: HTMLElement = textarea ?? el
        if (document.activeElement !== target) {
          if (textarea) textarea.focus({ preventScroll: true })
          else entry.terminal.focus()
        }
        if (!scrollRestored) {
          scrollRestored = true
          terminalRegistry.restoreScroll(panelId)
          requestAnimationFrame(() => terminalRegistry.restoreScroll(panelId))
        }
        // Re-check for ~500ms after first success to survive a detach/reattach
        // race from the IntersectionObserver right after mount.
        if (recheckAttempts++ < 20) setTimeout(tick, 25)
      }
      tick()
      return () => { myCancelled = true }
    }

    // Initial focus when this panel becomes the focused node.
    let stopRun: (() => void) | undefined
    if (isFocused) stopRun = runFocus()

    // Imperative subscription to focusEpoch — re-runs focus when the same node
    // is re-focused (no React re-render of this panel on unrelated focus actions).
    const unsubscribe = canvasApi.subscribe((s, prev) => {
      if (s.focusEpoch === prev.focusEpoch) return
      if (s.focusedNodeId !== nodeId) return
      stopRun?.()
      stopRun = runFocus()
    })

    return () => {
      cancelled = true
      stopRun?.()
      unsubscribe()
    }
  }, [isFocused, panelId, nodeId, canvasApi])

  // -------------------------------------------------------------------------
  // Crisp rendering at high canvas zoom
  //
  // The canvas applies a single scale(zoom) transform to the world div. That
  // CSS-upscales xterm's pre-rasterized glyph atlas, which looks pixelated at
  // zoom > 1. To stay sharp we mimic VS Code's webFrame-zoom trick: when zoom
  // settles on a higher step, we bump xterm's fontSize to the configured base
  // size * renderScale (forcing a fresh higher-resolution atlas) and counter-scale the render
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
      entry.terminal.options.fontSize = terminalBaseFontSize * renderScale
      // preserveGrid: the box and the cell grew by the same factor, so the
      // grid must not change — but ceil/parseInt quantization flips rows by
      // ±1 across scale steps, and each phantom SIGWINCH makes a TUI like
      // Claude Code stack a duplicate frame into scrollback (doubled content
      // that only a large vertical resize clears).
      terminalRegistry.fit(panelId, { preserveGrid: true })
      // The render box's layout size legitimately changed by the scale factor;
      // sync the ResizeObserver's last-fit size so its debounced plain fit()
      // doesn't run right after this and un-pin the grid.
      lastFitSizeRef.current = { w: renderBox.clientWidth, h: renderBox.clientHeight }

      if (wasAtBottom) entry.terminal.scrollToBottom()
    } catch {
      // Ignore — fit can throw on zero-size frames during layout transitions.
    }
  }, [renderScale, panelId, terminalBaseFontSize])

  // -------------------------------------------------------------------------
  // Repaint after the zoom settles
  //
  // The world div carries `will-change: transform`, so it (and every terminal's
  // WebGL <canvas>) lives on a GPU compositing layer. The WebGL renderer draws
  // with preserveDrawingBuffer:false and only repaints dirty rows, so when the
  // compositor re-rasterizes the layer at a new scale a static terminal's
  // drawing buffer comes up blank until xterm draws another frame.
  //
  // Zoom-IN happens to recover on its own because crossing a render-scale step
  // runs the fontSize/fit/refresh effect above. Zoom-OUT clamps renderScale to
  // 1.0 (snapRenderScale), so that effect early-returns and nothing ever
  // repaints — leaving the terminal blank until the next PTY output or a
  // zoom-in. Force a full refresh once the gesture settles to cover both
  // directions. Two idle frames debounce a continuous pinch to a single repaint.
  // -------------------------------------------------------------------------

  const repaintRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (repaintRafRef.current !== null) cancelAnimationFrame(repaintRafRef.current)
    repaintRafRef.current = requestAnimationFrame(() => {
      repaintRafRef.current = requestAnimationFrame(() => {
        repaintRafRef.current = null
        const renderBox = renderBoxRef.current
        if (!renderBox || renderBox.offsetParent === null) return
        const entry = terminalRegistry.getEntry(panelId)
        if (!entry) return
        try {
          entry.terminal.refresh(0, entry.terminal.rows - 1)
        } catch {
          // Ignore — refresh can throw mid-layout / mid-dispose.
        }
      })
    })
    return () => {
      if (repaintRafRef.current !== null) {
        cancelAnimationFrame(repaintRafRef.current)
        repaintRafRef.current = null
      }
    }
  }, [zoomLevel, panelId])

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
      // Don't touch coordinates while a canvas gesture (panel resize / pan) is
      // in flight. This handler runs in the capture phase and rewrites
      // e.clientX/Y; the node-resize listener is on window (bubble phase) and
      // would otherwise read the rewritten value, computing its delta from a
      // moving target (screenEl's rect shifts as the panel resizes). On a
      // zoomed canvas that feeds back every frame and the dragged edge runs
      // away from the cursor — the terminal-only "right edge jumps right while
      // dragging left" bug. xterm only needs adjusted coords for its own
      // selection, which isn't happening during a resize/pan anyway.
      if (document.body.classList.contains('canvas-interacting')) return

      // A middle/right press starts a canvas pan, not an xterm selection. This
      // capture handler runs before the canvas sets canvas-interacting, so the
      // guard above can't catch the pan's opening mousedown — we'd rewrite its
      // clientX/Y while every follow-up move (which lands on the now
      // pointer-events:none terminal -> canvas) stays raw. The first pan delta
      // would then be (raw - adjusted) and jump the camera on a zoomed canvas.
      // xterm only needs adjusted coords for left-button selection, so leave
      // non-left presses untouched.
      if (e.type === 'mousedown' && e.button !== 0) return

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

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Accept drops from internal file explorer or external file drops
    if (
      e.dataTransfer.types.includes('application/cate-file') ||
      e.dataTransfer.types.includes('Files')
    ) {
      // Stop here so the app-root background handler doesn't override the drop
      // effect to 'none' (which would suppress the drop event entirely and stop
      // file paths from being inserted into the terminal). The drop indicator
      // is driven globally via the capture-phase tracker, which still fires.
      e.stopPropagation()
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()

      const refs: DroppedRef[] = []

      // Internal file explorer / search drag. A search-line drag carries the
      // line number too — pasted as path:line (like a VS Code reference).
      const catePath = e.dataTransfer.getData('application/cate-file')
      if (catePath) {
        let line: number | undefined
        const lineRaw = e.dataTransfer.getData('application/cate-file-line')
        if (lineRaw) {
          try {
            const lr = JSON.parse(lineRaw) as { path?: string; line?: number }
            if (lr?.path === catePath) line = lr.line
          } catch { /* ignore */ }
        }
        refs.push({ path: catePath, line })
      }

      // External OS file drop — use Electron's webUtils to get real paths
      if (e.dataTransfer.files.length > 0) {
        for (const file of Array.from(e.dataTransfer.files)) {
          const filePath = window.electronAPI?.getPathForFile(file)
          if (filePath) refs.push({ path: filePath })
        }
      }

      if (refs.length === 0) return

      const entry = terminalRegistry.getEntry(panelId)
      if (entry) {
        entry.terminal.paste(formatTerminalPaste(refs))
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
        <div className="flex items-center gap-1 px-2 py-1 bg-surface-3 border-b border-subtle shrink-0">
          <input
            autoFocus
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                if (e.shiftKey) handleFindPrevious()
                else handleFindNext()
              }
              if (e.key === 'Escape') handleCloseSearch()
            }}
            className="flex-1 bg-surface-4 text-primary text-xs px-2 py-1 rounded border border-subtle outline-none focus:border-blue-500/50"
            placeholder="Search terminal..."
          />
          <button
            onClick={handleFindPrevious}
            className="text-secondary hover:text-primary text-xs px-1"
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            onClick={handleFindNext}
            className="text-secondary hover:text-primary text-xs px-1"
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            onClick={handleCloseSearch}
            className="text-secondary hover:text-primary text-xs px-1"
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
        data-filedrop="terminal"
        data-filedrop-id={panelId}
        onDragOver={handleDragOver}
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
        {/* File-drop indicator is rendered globally by <FileDropOverlay/>
            (this container is marked data-filedrop="terminal"). */}
        {/* Inline URL prompt is rendered outside this scaled box so it
            stays at panel scale regardless of renderScale. */}
        {createError && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-1/85 backdrop-blur-sm">
            <div className="max-w-md mx-6 rounded-lg border border-subtle bg-surface-3 shadow-[0_18px_40px_-12px_var(--shadow-node)] p-4 text-center">
              <div className="text-[13px] font-semibold text-primary mb-1">
                Failed to start terminal
              </div>
              <div className="text-[12px] text-secondary mb-3 break-words whitespace-pre-wrap leading-snug">
                {createError}
              </div>
              <button
                type="button"
                onClick={handleRetry}
                className="px-3 py-1.5 rounded-md bg-[var(--focus-blue,#3b82f6)] text-white text-[12px] font-medium hover:brightness-110 active:scale-[0.97] focus:outline-none transition-all"
              >
                Retry
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
