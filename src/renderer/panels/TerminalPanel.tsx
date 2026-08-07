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
import { useClaimPanelCorner } from './panelChrome'
import { useOptionalCanvasStoreApi, useOptionalCanvasStoreContext } from '../stores/CanvasStoreContext'
import { useUIStore } from '../stores/uiStore'
import { useMissingAgentHookNotice } from '../hooks/useMissingAgentHookNotice'
import { Warning } from '@phosphor-icons/react'
import { focusedNodeId } from '../stores/canvas/selectionModel'
import { useActivePanelStore, getActivePanelId } from '../lib/activePanel'
import { collectPanelIds } from '../../shared/collectPanelIds'
import { resolveTerminalFontSize } from '../lib/terminal/terminalSettings'
import { shouldAdjustTerminalCoords } from '../lib/terminal/terminalCoordAdjust'
import { snapRenderScale } from '../lib/terminal/renderScale'
import { resolveWorktree } from '../../shared/worktrees'
import { resumeCommandForAgent } from '../../shared/agents'
import { CATE_FILE_MIME, hasChatDrag, readCateFileLocation, readCateFilePaths } from '../drag/fileDragPayload'
import { parseLocator } from '../../shared/runtimeLocator'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TerminalPanel({
  panelId,
  workspaceId,
  nodeId,
  initialInput,
  codingAgentLaunch,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const renderBoxRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)
  const fitRafRef = useRef<number | null>(null)
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastFitSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 })
  const [renderScale, setRenderScale] = useState(1.0)
  // xterm ceils its cell pixels, so bumping fontSize to base × renderScale does
  // NOT grow the cell by exactly renderScale (cell(k·fs) ≠ k·cell(fs)) — it
  // overshoots. Measured at 13px/DPR 1: renderScale 1.25 wants a 8.75px cell
  // and gets 9 (+2.9%), 1.5 wants 10.5 and gets 11 (+4.8%).
  //
  // Sizing the render box by renderScale while the cell grew by more than that
  // is what silently resized the terminal on every zoom step: the box grew
  // 1.25× but the cell grew 1.286×, so 90 columns became 87. preserveGrid only
  // absorbs ±1, so a 3-4 column jump went straight through to the PTY as a
  // SIGWINCH and reflowed the shell/TUI.
  //
  // So drive the layout off the MEASURED cell instead. With
  //   box = container × (cell / baseCell)
  // the column count is container/baseCell — renderScale cancels out entirely,
  // and the counter-scale below pins the on-screen cell to its base size.
  // Width and height are tracked separately because the two ceil independently.
  // The DPR the baseline was taken at is part of the baseline: xterm rounds the
  // cell to DEVICE pixels and reports it back in CSS pixels
  // (css.cell = round(char × dpr) / dpr), so the same font measures 7px on a
  // DPR 1 display and can measure 6.5px on a DPR 2 one. A baseline captured on
  // one screen is simply wrong on the other.
  const baseCellRef = useRef<{ w: number; h: number; dpr: number } | null>(null)
  const [cellScale, setCellScale] = useState({ w: 1, h: 1 })
  // Bumped whenever something outside this component's own state makes the
  // terminal measurable again, or makes an existing measurement invalid:
  // attach() (xterm finally has a DOM element — without this a panel mounted at
  // zoom > 1 would measure nothing and never retry, since renderScale has
  // already settled) and a DPR change (see above).
  const [measureEpoch, setMeasureEpoch] = useState(0)
  const terminalBaseFontSize = useSettingsStore((state) =>
    resolveTerminalFontSize(state.terminalFontSize),
  )

  // A font-size change moves the baseline everything is measured against. Drop
  // it so the next pass re-derives it instead of scaling toward a cell size
  // that no longer exists.
  useEffect(() => {
    baseCellRef.current = null
  }, [terminalBaseFontSize])

  // Same for a DPR change — dragging the window to a display with a different
  // pixel density re-rounds every cell. Nothing else would notice: the render
  // box keeps its CSS size, so the ResizeObserver stays quiet, and renderScale
  // is already at its target, so the measuring effect has no reason to re-run.
  // The grid would stay wrong until the user happened to zoom or resize.
  //
  // A resolution media query only matches the DPR it was built with, so it has
  // to be re-armed at the new value after each change.
  useEffect(() => {
    let query: MediaQueryList | null = null
    let measureRaf: number | null = null
    let disposed = false

    const onChange = (): void => {
      baseCellRef.current = null
      // xterm watches DPR through its own MediaQueryList. Defer our read until
      // the next frame so every resolution-change listener has refreshed its
      // cell geometry before we capture the new baseline.
      if (measureRaf !== null) cancelAnimationFrame(measureRaf)
      measureRaf = requestAnimationFrame(() => {
        measureRaf = null
        setMeasureEpoch((n) => n + 1)
      })
      arm()
    }
    function arm(): void {
      if (disposed) return
      query?.removeEventListener('change', onChange)
      query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      query.addEventListener('change', onChange)
    }
    arm()

    return () => {
      disposed = true
      if (measureRaf !== null) cancelAnimationFrame(measureRaf)
      query?.removeEventListener('change', onChange)
    }
  }, [])

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

  // A create failure usually means the host's runtime is down (the local
  // daemon failed to start, or a remote dropped) — re-running create alone can
  // never fix that. Re-kick the runtime first, then re-run create either way
  // so the freshest error surfaces if it still fails.
  const [retrying, setRetrying] = useState(false)
  const retryRuntime = useAppStore((state) => state.retryRuntime)
  const handleRetry = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    void (async () => {
      try {
        await retryRuntime(workspaceId)
      } finally {
        setRetrying(false)
        setCreateError(null)
        setRetryKey((k) => k + 1)
      }
    })()
  }, [retrying, retryRuntime, workspaceId])

  const workspaces = useAppStore((state) => state.workspaces)
  const panelCwd = useAppStore(
    (state) => state.workspaces.find((w) => w.id === workspaceId)?.panels[panelId]?.cwd,
  )
  const placementGroupId = useAppStore(
    (state) => state.workspaces.find((w) => w.id === workspaceId)?.panels[panelId]?.placementGroupId,
  )
  // The worktree this terminal is tagged to (the title-bar pill), resolved to its
  // checkout path. This is the AUTHORITATIVE cwd for a tagged terminal — same as
  // CateAgentPanel — so a restart respawns it inside its worktree regardless of
  // whether the live cwd was captured at save time (which is flaky: it depends on
  // a live PTY query). Returns a stable string, so this selector is cheap.
  const taggedWorktreePath = useAppStore((state) => {
    const ws = state.workspaces.find((w) => w.id === workspaceId)
    return resolveWorktree(ws?.panels[panelId]?.worktreeId, ws?.worktrees)?.path
  })
  // Bumped by respawnPanelTerminal() to force a fresh PTY at a new cwd (worktree
  // switch). Folded into the lifecycle effect deps below so it re-creates.
  const ptyEpoch = useAppStore(
    (state) => state.workspaces.find((w) => w.id === workspaceId)?.panels[panelId]?.ptyEpoch ?? 0,
  )
  const workspaceRoot = workspaces.find((w) => w.id === workspaceId)?.rootPath
  // Tagged worktree wins; else an explicit per-panel cwd (drag-drop folder); else
  // the workspace root.
  const rootPath = taggedWorktreePath || panelCwd || workspaceRoot
  const rootPathRef = useRef(rootPath)
  rootPathRef.current = rootPath

  const isFocused = useOptionalCanvasStoreContext((s) => focusedNodeId(s) === nodeId, false)
  const canvasApi = useOptionalCanvasStoreApi()
  const zoomLevel = useOptionalCanvasStoreContext((s) => s.zoomLevel, 1)

  // A supported agent CLI running here with no Cate hooks installed → a small
  // "hooks off" chip linking to Settings (auto-clears when resolved).
  const missingHookAgent = useMissingAgentHookNotice(workspaceId, panelId, rootPath)

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

  // The search row sits in the panel's top-right, where the host overlays the
  // worktree chip — claim the corner so the chip stands down while it's up.
  useClaimPanelCorner(showSearch)

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
      // xterm now has a DOM element, so the render-scale effect can measure the
      // cell. It may have already run and bailed (panel mounted at zoom > 1).
      setMeasureEpoch((n) => n + 1)

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

    // Agent session persisted at last save (terminal restore): resolve it to
    // the resume command the lifecycle types into the fresh shell. Read via
    // getState — the stamp is written back whenever the agent's hook events
    // report a session change, and must not re-run this lifecycle effect.
    const agentSession = useAppStore.getState().workspaces
      .find((w) => w.id === workspaceId)?.panels[panelId]?.agentSession
    const resumeCommand = agentSession
      ? resumeCommandForAgent(agentSession.agentId, agentSession.sessionId) ?? undefined
      : undefined

    // 1. Ensure the terminal + PTY exist in the registry (no-op if already live)
    terminalRegistry
      .getOrCreate(panelId, {
        workspaceId,
        cwd: rootPathRef.current || undefined,
        initialInput,
        codingAgentLaunch,
        resumeCommand,
        placementGroupId,
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
  }, [panelId, workspaceId, nodeId, initialInput, codingAgentLaunch, placementGroupId, retryKey, ptyEpoch])

  // -------------------------------------------------------------------------
  // Focus xterm when this node becomes the focused node
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false

    /**
     * False when a SIBLING panel of this node owns the active panel — i.e. this
     * node's mini-dock is split and the user is working in the other pane.
     *
     * Node focus is per-NODE, so every pane of a split sees isFocused === true.
     * Without this gate all of them re-assert `textarea.focus()` on the same
     * 25 ms tick and the last one to fire wins, which is how a click (and the
     * Cmd+C that follows it — Electron's `role: 'copy'` copies from whatever
     * holds DOM focus) lands on the wrong terminal. Deliberately permissive: an
     * unset or out-of-node active panel still focuses, so a single-terminal node
     * behaves exactly as before.
     */
    const ownsNodeFocus = (): boolean => {
      const active = getActivePanelId()
      if (!active || active === panelId) return true
      const layout = nodeId ? canvasApi?.getState().nodes[nodeId]?.dockLayout : null
      if (!layout) return true
      const siblings = collectPanelIds(layout)
      return !(siblings.includes(active) && siblings.includes(panelId))
    }

    const runFocus = () => {
      let waitAttempts = 0
      let recheckAttempts = 0
      let scrollRestored = false
      let myCancelled = false
      const tick = () => {
        if (cancelled || myCancelled) return
        if (!ownsNodeFocus()) return
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
    const unsubscribe = canvasApi?.subscribe((s, prev) => {
      if (s.focusEpoch === prev.focusEpoch) return
      if (focusedNodeId(s) !== nodeId) return
      stopRun?.()
      stopRun = runFocus()
    })

    // Becoming the active pane of a focused split node: take DOM focus. Covers
    // a press that lands on pane chrome rather than the xterm element itself
    // (xterm focuses its own textarea on a direct mousedown).
    const unsubscribeActive = useActivePanelStore.subscribe((s, prev) => {
      if (s.activePanelId === prev.activePanelId) return
      if (s.activePanelId !== panelId) return
      const state = canvasApi?.getState()
      if (state && nodeId && focusedNodeId(state) !== nodeId) return
      stopRun?.()
      stopRun = runFocus()
    })

    return () => {
      cancelled = true
      stopRun?.()
      unsubscribe?.()
      unsubscribeActive()
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

      const screenEl = entry.terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
      const cols = entry.terminal.cols
      const rows = entry.terminal.rows
      const measurable = !!screenEl && cols > 0 && rows > 0 && screenEl.offsetWidth > 0

      // Bail before touching fontSize, not after. terminal.element only exists
      // once attach() has opened xterm into the render box, and getOrCreate is
      // async — so on a panel mounted while the canvas is ALREADY zoomed, this
      // effect can run first. Bumping the font here would grow the cell while
      // cellScale stayed at 1, which is precisely the box/cell mismatch this
      // effect exists to prevent, and nothing would recompute it: renderScale
      // has already settled, so the effect would not run again on its own.
      // measureEpoch below re-triggers it once xterm is measurable.
      if (!measurable) return

      // The baseline is the cell at the UNSCALED font, and it can only be read
      // at that font — a scaled cell cannot be divided back down, because the
      // ceil already threw the remainder away (at 1.5 the cell is 11, and
      // 11/1.5 = 7.33 for a cell that is really 7; that 4.8% error then shrank
      // the box at every scale, including 1).
      //
      // So when a panel is first laid out already zoomed in, take the reading
      // directly: drop to the base font, measure, and go straight back up. Both
      // writes and the measurement happen in this one synchronous block, and
      // reading offsetWidth forces the layout that makes the middle reading
      // real, so the browser never paints the intermediate state. Costs one
      // extra glyph-atlas rebuild, once per panel.
      if (!baseCellRef.current && renderScale !== 1) {
        entry.terminal.options.fontSize = terminalBaseFontSize
        if (screenEl!.offsetWidth > 0) {
          baseCellRef.current = {
            w: screenEl!.offsetWidth / cols,
            h: screenEl!.offsetHeight / rows,
            dpr: window.devicePixelRatio,
          }
        }
      }

      // Mutating options.fontSize triggers xterm's internal renderer refresh,
      // which rebuilds the WebGL glyph atlas at the new resolution. xterm
      // relays out the cell synchronously, so the grid can be measured below.
      entry.terminal.options.fontSize = terminalBaseFontSize * renderScale

      // No fit() here. Fitting against a box still sized for the PREVIOUS cell
      // is exactly what dropped columns (see cellScale). Measure the new cell,
      // resize the box to match it, and let the ResizeObserver's plain fit run
      // against a box that is already in proportion — at which point it
      // computes the same column count and never resizes the PTY at all.
      {
        const cellW = screenEl!.offsetWidth / cols
        const cellH = screenEl!.offsetHeight / rows
        // At renderScale 1 the target font IS the base font, so this reading is
        // itself the baseline — no second pass needed.
        if (renderScale === 1) {
          baseCellRef.current = { w: cellW, h: cellH, dpr: window.devicePixelRatio }
        }
        const base = baseCellRef.current
        const next = base
          ? { w: cellW / base.w, h: cellH / base.h }
          : { w: renderScale, h: renderScale }
        // Guard a mid-layout read: the scale tracks renderScale to within a few
        // percent, so anything outside the step range is noise, not signal.
        if (next.w > 0.5 && next.w < 3 && next.h > 0.5 && next.h < 3) setCellScale(next)
      }

      if (wasAtBottom) entry.terminal.scrollToBottom()
    } catch {
      // Ignore — fit can throw on zero-size frames during layout transitions.
    }
  }, [renderScale, panelId, terminalBaseFontSize, measureEpoch])

  // The --cell-scale above has just changed the scrollbar's width, and xterm
  // caches that width once at construction — so re-measure and write it back
  // BEFORE anything fits against it, or FitAddon subtracts a stale track and
  // returns a column count too wide for the viewport (clipped right-hand
  // columns). This effect runs after the style is committed, and the sync
  // itself flushes layout before reading, so the measurement is live.
  //
  // With both the box and the scrollbar scaling by the cell ratio, a plain
  // fit() now computes the same column count it had before — the scale cancels
  // out of (box - scrollbar) / cell. So the ResizeObserver is left alone to do
  // its job; a genuine panel resize must still re-fit.
  useEffect(() => {
    const renderBox = renderBoxRef.current
    if (!renderBox || renderBox.offsetParent === null) return
    if (renderBox.clientWidth === 0 || renderBox.clientHeight === 0) return
    terminalRegistry.syncScrollBarWidth(panelId)
  }, [cellScale, panelId])

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
    //   inner render box: scale(1/cellScale.w, 1/cellScale.h)  (see effect above)
    //   outer world div : scale(zoomLevel)
    // so screen pixels = DOM pixels × zoomLevel / cellScale, PER AXIS — the two
    // differ by a couple of percent, which is enough to drift a selection by a
    // row near the bottom of a tall terminal, so each axis converts by its own.
    // xterm computes hit-testing against its own DOM-space cell metrics, so we
    // must convert the incoming screen-space offset back into DOM space.
    const adjustCoords = (e: MouseEvent) => {
      // Whether to rewrite this event's clientX/Y lives in a pure helper so the
      // middle-click-pan regression it prevents can be unit-tested. It skips the
      // rewrite when a canvas gesture owns the pointer (canvas-interacting), for
      // every event in a non-left-button gesture, and when the canvas isn't
      // zoomed. See terminalCoordAdjust.ts for the full rationale.
      const effective = zoomLevel / cellScale.w
      const effectiveY = zoomLevel / cellScale.h
      if (
        !shouldAdjustTerminalCoords(
          e.type,
          e.button,
          document.body.classList.contains('canvas-interacting'),
          effective,
          e.buttons,
        )
      )
        return

      // Find xterm's screen element — the same element xterm uses for its
      // own getBoundingClientRect() call in getCoordsRelativeToElement()
      const screenEl = container.querySelector('.xterm-screen') as HTMLElement | null
      if (!screenEl) return

      const rect = screenEl.getBoundingClientRect()
      // Convert screen-space offset to local (DOM-space) offset
      const adjustedX = rect.left + (e.clientX - rect.left) / effective
      const adjustedY = rect.top + (e.clientY - rect.top) / effectiveY

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
  }, [zoomLevel, cellScale])

  // -------------------------------------------------------------------------
  // Drag-and-drop: accept files from OS or internal file explorer
  // -------------------------------------------------------------------------

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Accept drops from internal file explorer or external file drops
    if (
      e.dataTransfer.types.includes(CATE_FILE_MIME) ||
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
      // A dragged chat isn't a file path to paste — let it bubble to the canvas /
      // dock zone, which opens it as an agent panel. Swallowing it here (the
      // stopPropagation below) is what made a chat dropped over a terminal do nothing.
      if (hasChatDrag(e.dataTransfer)) return
      e.preventDefault()
      e.stopPropagation()

      const refs: DroppedRef[] = []

      // Internal file explorer / search drag. A search-line drag carries the
      // line number too — pasted as path:line (like a VS Code reference).
      const catePath = readCateFilePaths(e.dataTransfer)[0]
      if (catePath) {
        const location = readCateFileLocation(e.dataTransfer)
        const line = location?.path === catePath ? location.line : undefined
        // Tree/search nodes carry locator-encoded paths (cate-runtime://… for a
        // remote workspace). The shell runs ON that workspace's host, so paste
        // the bare host path; for local paths parseLocator is a pass-through.
        refs.push({ path: parseLocator(catePath).path, line })
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
    <div className="relative w-full h-full flex flex-col" style={{ padding: 0 }}>
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
            className="flex-1 bg-surface-4 text-primary text-xs px-2 py-1 rounded-lg border border-subtle outline-none focus:border-focus"
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
          data-terminal-render-box=""
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: `${100 * cellScale.w}%`,
            height: `${100 * cellScale.h}%`,
            // Per-axis, not uniform: width and height ceil independently, so the
            // cell's aspect ratio shifts slightly per scale step (7:15 → 9:19 →
            // 11:23). A uniform width-driven counter-scale therefore left the
            // height 1.5-2.4% short depending on the step, which read as the
            // terminal's vertical size wobbling on zoom. Undoing each axis by
            // its own measured ratio lands the on-screen cell back on exactly
            // baseCell × baseCell at every step. The glyph inside is then off
            // its true aspect by the same ~2%, which is imperceptible — and far
            // preferable to a grid that visibly resizes.
            transform: `scale(${1 / cellScale.w}, ${1 / cellScale.h})`,
            transformOrigin: '0 0',
            // Drives the scrollbar rule in globals.css so the track scales with
            // the cell instead of thinning as the terminal zooms in.
            ['--cell-scale' as string]: String(cellScale.w),
          }}
        />
        {/* Supported agent running without Cate hooks — nudge to Settings. */}
        {missingHookAgent && (
          <button
            type="button"
            onClick={() => useUIStore.getState().openSettings('agent hooks')}
            title={`${missingHookAgent} is running without Cate hooks — click to set them up in Settings`}
            className="absolute bottom-2 right-2 z-30 flex items-center gap-1 px-2 py-1 rounded-md bg-surface-3/90 border border-subtle text-[11px] text-secondary hover:text-primary backdrop-blur-sm transition-colors focus:outline-none"
          >
            <Warning size={11} className="flex-shrink-0" />
            Agent hooks off
          </button>
        )}
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
                disabled={retrying}
                className="px-3 py-1.5 rounded-md bg-[var(--focus-blue,#3b82f6)] text-white text-[12px] font-medium hover:brightness-110 active:scale-[0.97] focus:outline-none transition-all disabled:opacity-60 disabled:pointer-events-none"
              >
                {retrying ? 'Reconnecting…' : 'Retry'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
