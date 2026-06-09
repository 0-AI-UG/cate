// =============================================================================
// terminalDom — DOM lifecycle for terminals: attach/detach the xterm element to
// a container, fit it to its container, and save/restore the buffer viewport
// across reparents. Imports finalizeReconnect down from terminalLifecycle.
// =============================================================================

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { registry, has, type RegistryEntry } from './registryState'
import { finalizeReconnect } from './terminalLifecycle'

/**
 * Force the WebGL renderer to rebuild its glyph atlas and redraw every cell.
 *
 * A detached window is created hidden (show:false) and only revealed on
 * ready-to-show. The WebGL renderer initializes while the window is still
 * hidden, so its glyph atlas is built against whatever devicePixelRatio the
 * not-yet-composited window reports and its drawing buffer is never painted.
 * Once the window is shown a stale atlas yields garbled text (wrong cell
 * metrics) and a quiet terminal stays blank (the buffer comes up empty and,
 * with preserveDrawingBuffer:false, nothing redraws it). clearTextureAtlas()
 * rebuilds the atlas at the now-correct DPR; refresh() repaints into the live
 * buffer. No-op (besides a cheap refresh) on the canvas renderer fallback.
 */
function forceWebglRepaint(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return
  try {
    entry.webglAddon?.clearTextureAtlas()
    entry.terminal.refresh(0, entry.terminal.rows - 1)
  } catch {
    /* renderer mid-dispose — ignore */
  }
}

/**
 * Calls fitAddon.fit() and corrects for sub-pixel overflow.
 *
 * FitAddon calculates rows from getComputedStyle height, which can be
 * fractionally larger than the actual visible area due to calc/flex
 * rounding. When the resulting xterm element is taller than its
 * overflow:hidden container, the bottom row(s) get clipped — but
 * xterm's scrollbar doesn't account for the clipping, so
 * scrollToBottom() leaves content invisible.
 */
function safeFit(terminal: Terminal, fitAddon: FitAddon, container: HTMLElement): void {
  // Coalesce into a single terminal.resize() call so the PTY only receives one
  // SIGWINCH per fit. Two rapid resizes confuse TUI agents (claude code, vim,
  // htop) which redraw their full frame on each SIGWINCH — the second redraw
  // can land at a row index that the first resize had already invalidated,
  // leaving the bottom row clipped from view.
  const proposed = fitAddon.proposeDimensions()
  if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return

  let { cols, rows } = proposed
  cols = Math.max(1, Math.floor(cols))
  rows = Math.max(1, Math.floor(rows))

  // Sub-pixel overflow guard: FitAddon derives rows from getComputedStyle
  // height which can round up past the actual visible (overflow:hidden) area.
  // Probe the cell height by reading any existing row, falling back to a
  // single-resize-then-measure if the terminal hasn't been opened yet.
  const xtermEl = (terminal as unknown as { element?: HTMLElement }).element
  if (xtermEl) {
    const cellHeight = xtermEl.offsetHeight > 0 && terminal.rows > 0
      ? xtermEl.offsetHeight / terminal.rows
      : 0
    if (cellHeight > 0 && rows * cellHeight > container.offsetHeight + 0.5) {
      rows = Math.max(1, rows - 1)
    }
  }

  if (cols !== terminal.cols || rows !== terminal.rows) {
    terminal.resize(cols, rows)
  }

  // Make sure the visible grid and the buffer agree on the new size in a
  // single settled state — refresh the rendered cells and pin the viewport
  // to the bottom so the freshest TUI frame is on screen.
  try {
    terminal.refresh(0, terminal.rows - 1)
    terminal.scrollToBottom()
  } catch { /* ignore */ }
}

/**
 * Moves the xterm DOM element into container and calls fitAddon.fit().
 *
 * If the terminal is currently attached to a different container it is
 * detached first. Safe to call multiple times with the same container.
 *
 * When reparenting, the WebGL addon is disposed and reloaded because its
 * internal canvas buffers can become stale after a DOM move, causing garbled
 * rendering (characters drawn at wrong positions).
 */
export function attach(panelId: string, container: HTMLDivElement): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const { terminal, fitAddon } = entry

  // First-time attach: terminal.open() hasn't been called yet (see
  // getOrCreate). Open directly into the real container so xterm builds its
  // DOM and WebGL canvas with valid layout dimensions from the start.
  let el = (terminal as unknown as { element?: HTMLElement }).element
  if (!el) {
    terminal.open(container)
    el = (terminal as unknown as { element?: HTMLElement }).element
    if (!el) return
  } else {
    // Already attached to this exact container — just re-fit
    if (el.parentElement === container) {
      try { safeFit(terminal, fitAddon, container) } catch { /* ignore */ }
      return
    }

    // Detach from any previous container without disposing
    if (el.parentElement) {
      el.parentElement.removeChild(el)
    }

    container.appendChild(el)
  }

  // Track viewport scroll position continuously so we can restore it on focus.
  // Only add the listener once — attach() may be called many times by the
  // IntersectionObserver visibility toggle, and the xterm DOM tree (including
  // .xterm-viewport) is the same object across reparents. Adding duplicates
  // leaks closures and grows cleanupListeners without bound.
  if (!entry.hasScrollListener) {
    const viewport = el.querySelector('.xterm-viewport') as HTMLElement | null
    if (viewport) {
      const onScroll = (): void => {
        const e = registry.get(panelId)
        if (e) e.lastScrollTop = viewport.scrollTop
        // Self-heal the bug where the DOM scrollbar reaches the bottom but the
        // xterm buffer's viewportY is one short of baseY (leaving the freshest
        // row invisible). When the user drags the scrollbar all the way down,
        // force the buffer index to match.
        if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2) {
          const current = registry.get(panelId)
          try { current?.terminal.scrollToBottom() } catch { /* ignore */ }
        }
      }
      viewport.addEventListener('scroll', onScroll, { passive: true })
      entry.cleanupListeners.push(() => viewport.removeEventListener('scroll', onScroll))
      entry.hasScrollListener = true
    }
  }

  // Repaint when the window becomes visible. A detached window is created
  // hidden (show:false) and revealed on ready-to-show; if the WebGL renderer
  // initialized while the window was still hidden, its drawing buffer never
  // painted and its atlas was built against a stale DPR — leaving the terminal
  // blank or garbled until something forces a redraw. The same blank-buffer
  // race happens on minimize/restore. Force an atlas rebuild + refresh on every
  // visible transition. Registered once per entry (survives re-attach cycles).
  if (!entry.hasVisibilityListener) {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') forceWebglRepaint(panelId)
    }
    document.addEventListener('visibilitychange', onVisible)
    entry.cleanupListeners.push(() => document.removeEventListener('visibilitychange', onVisible))
    entry.hasVisibilityListener = true
  }

  // Force layout reflow so the browser has calculated the new container size
  // before we resize the terminal / WebGL canvas.
  void container.offsetHeight

  // Reload the WebGL addon — its internal canvas buffers are tied to the old
  // container dimensions and cannot survive a DOM reparent reliably.
  if (entry.webglAddon) {
    try { entry.webglAddon.dispose() } catch { /* ignore */ }
    entry.webglAddon = null
  }
  try {
    const newWebgl = new WebglAddon()
    newWebgl.onContextLoss(() => {
      newWebgl.dispose()
      const e = registry.get(panelId)
      if (e) e.webglAddon = null
    })
    terminal.loadAddon(newWebgl)
    entry.webglAddon = newWebgl
  } catch {
    // Canvas renderer fallback — no action needed
  }

  // Fit after the next frame — the container may still be mid-layout during
  // the sync DOM append (e.g. WebGL canvas initialization).  Retry up to 5
  // frames for new windows that are still settling layout.
  let retries = 0
  function tryFit(): void {
    if (!has(panelId)) return
    if ((container.offsetWidth === 0 || container.offsetHeight === 0) && retries < 5) {
      retries++
      requestAnimationFrame(tryFit)
      return
    }
    fitAndScroll()
  }
  requestAnimationFrame(tryFit)

  function fitAndScroll(): void {
    const liveEntry = registry.get(panelId)
    if (!liveEntry) return
    try {
      // If a scroll position was saved when this panel was last hidden (dock
      // tab switch, IntersectionObserver hide), restore it AFTER fit so the
      // re-shown terminal returns to where the user left it instead of the top.
      // The DOM scrollTop is unreliable here: a fresh appendChild zeroes it, so
      // we restore by buffer line index (captured at detach).
      const saved = liveEntry.savedViewport

      // Use DOM-based scroll check — buffer indices (viewportY/baseY) become
      // stale after fit() changes the row count. Only consulted when there is
      // no saved snapshot (first attach, or a non-detach re-fit).
      const viewport = terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null
      const wasAtBottom = viewport
        ? Math.abs(viewport.scrollTop - (viewport.scrollHeight - viewport.clientHeight)) < 5
        : true

      safeFit(terminal, fitAddon, container)
      terminal.refresh(0, terminal.rows - 1)

      if (saved) {
        restoreScroll(panelId)
        liveEntry.savedViewport = undefined
      } else if (wasAtBottom) {
        terminal.scrollToBottom()
      }
    } catch { /* ignore */ }

    // Rebuild the WebGL atlas + redraw now that we have run post-show with a
    // real container size, then again on the next two frames. A detached
    // window opens hidden and only paints once shown; its renderer initialized
    // while hidden against a stale DPR/size, so the first paint can be blank or
    // garbled until the atlas is rebuilt at the live DPR. The extra frames
    // cover a window still settling its size/DPR on the first painted frame.
    forceWebglRepaint(panelId)
    requestAnimationFrame(() => {
      forceWebglRepaint(panelId)
      requestAnimationFrame(() => forceWebglRepaint(panelId))
    })

    // Now that the xterm is sized to its real container, replay captured
    // scrollback and release the main-side PTY buffer. Order matters:
    // scrollback first (so visual continuity appears above any flushed
    // PTY output), ack second.
    try { finalizeReconnect(panelId) } catch { /* ignore */ }
  }
}

/**
 * Safely fit the terminal to its current container, correcting for
 * sub-pixel overflow. No-op if the terminal is not attached to a container.
 */
export function fit(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const { terminal, fitAddon } = entry
  const el = (terminal as unknown as { element?: HTMLElement }).element
  const container = el?.parentElement
  if (!el || !container) return

  safeFit(terminal, fitAddon, container)
}

/**
 * Snapshot the current buffer viewport position so it can be restored after the
 * xterm element is detached + re-attached (which zeroes the DOM scrollTop) or
 * after fit() changes the row count. Stored as a buffer LINE index plus an
 * at-bottom flag (so a follow-output terminal re-pins to the freshest line
 * rather than a stale index). No-op when there is no scrollback (baseY === 0).
 */
function captureViewport(entry: RegistryEntry): void {
  try {
    const active = entry.terminal.buffer.active
    if (active.baseY <= 0) {
      entry.savedViewport = undefined
      return
    }
    entry.savedViewport = {
      line: active.viewportY,
      atBottom: active.viewportY >= active.baseY,
    }
  } catch {
    /* buffer unavailable mid-dispose — ignore */
  }
}

/**
 * Restore the viewport from the saved buffer line index (captured on detach).
 * Restoring by line index is robust to the scrollTop reset that a DOM reparent
 * causes and to fit()'s row-count change. A follow-output terminal (atBottom)
 * snaps to the freshest line via scrollToBottom(). Falls back to the
 * continuously-tracked pixel scrollTop when no buffer snapshot exists (e.g. a
 * terminal that never had scrollback).
 *
 * Called both from the canvas-focus path (TerminalPanel focus effect) and from
 * attach()'s fitAndScroll() — the latter covers dock tab switches, which never
 * mark the panel as the canvas "focused node".
 */
export function restoreScroll(panelId: string): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const saved = entry.savedViewport
  if (saved) {
    try {
      if (saved.atBottom) entry.terminal.scrollToBottom()
      else entry.terminal.scrollToLine(saved.line)
      return
    } catch {
      /* fall through to the pixel-based path below */
    }
  }

  const viewport = (entry.terminal as unknown as { element?: HTMLElement }).element
    ?.querySelector('.xterm-viewport') as HTMLElement | null
  if (viewport && entry.lastScrollTop > 0) {
    viewport.scrollTop = entry.lastScrollTop
  }
}

/**
 * Removes the xterm DOM element from its current container.
 * Does NOT dispose the terminal or kill the PTY — the terminal remains live
 * in the registry and can be re-attached via attach().
 *
 * If `fromContainer` is provided, only detach when the element is currently
 * inside that specific container.  This prevents an unmounting component from
 * tearing the terminal out of a *new* container that already called attach().
 */
export function detach(panelId: string, fromContainer?: HTMLElement): void {
  const entry = registry.get(panelId)
  if (!entry) return

  const el = (entry.terminal as unknown as { element?: HTMLElement }).element
  if (!el?.parentElement) return

  if (fromContainer && el.parentElement !== fromContainer) return

  // Save the scroll position BEFORE removing the element. Re-inserting a
  // scrollable element on the next attach() zeroes its scrollTop, so without
  // this snapshot a dock tab switch (unmount → remount) loses the position and
  // the re-shown terminal jumps to the top.
  captureViewport(entry)

  el.parentElement.removeChild(el)
}
