// The terminal view: an xterm bound to the session's PTY. The session owns the
// PTY and publishes its id; this view attaches to the terminal service's
// stream with `bindTerminal` (serialized screen, then live output, with flow
// control), and owns everything visual: the grid, render scale on a zoomed
// canvas, search, links, keymaps and OSC 52.
//
// The xterm has the PTY's grid (parts/grid); a Fit button fits the PTY to
// this view when it fits another.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRuntime } from '../../kernel/rpc'
import { Spinner, getActiveTheme, subscribeTheme } from '../../kernel/interaction'
import { clientUi } from '@kernel/interaction'
import { bindTerminal, type TerminalBinding } from '@services/terminal/client'
import { clientStateFor } from '@client/document'
import { useClientState, useDocument } from '../../client/document'
import { useClaimPanelCorner } from '../../client/host/panelChrome'
import { type PanelViewProps } from '../../client/host/views'
import { dropFilesInto, isFileDrag } from '../../client/layout/drag'
import { isCanvasDock, placementOf } from '@workspace/document/contract'
import { fsClient } from '@workspace/files/client'
import type { TerminalOp, TerminalSnapshot } from '@panels/terminal/contract/types'
import { shouldAdjustTerminalCoords } from './parts/coordAdjust'
import { formatTerminalPaste } from './parts/drop'
import { snapRenderScale } from './parts/renderScale'
import { createTerminalLinkHandler } from './parts/input'
import { holdFocus } from './parts/holdFocus'
import { isMacKeyboard } from './parts/platform'
import { setTerminalViewSetting, terminalOptions, terminalViewSettings, useTerminalOptions } from './parts/settings'
import { useTerminalGrid } from './parts/grid'
import { createTerminalXterm, type TerminalXterm } from './parts/xterm'
import { registerTerminalView } from './tabMenu'

const interacting = () => document.body.classList.contains('canvas-interacting')

export default function TerminalView({
  workspaceId,
  panelId,
  snapshot,
  send,
  visible,
}: PanelViewProps<TerminalSnapshot, TerminalOp>) {
  const runtime = useRuntime(workspaceId)
  const processProxy = runtime?.process ?? null
  const options = useTerminalOptions()
  const containerRef = useRef<HTMLDivElement>(null)
  const renderBoxRef = useRef<HTMLDivElement>(null)
  const xtermRef = useRef<TerminalXterm | null>(null)
  const bindingRef = useRef<TerminalBinding | null>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  const sendRef = useRef(send)
  sendRef.current = send
  const [ready, setReady] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [retrying, setRetrying] = useState(false)
  // The search row sits where the host shows the worktree chip.
  useClaimPanelCorner(showSearch)

  const canvasId = useDocument(workspaceId, (doc) => {
    const placement = placementOf(doc, panelId)
    return placement && isCanvasDock(placement.dock) ? placement.dock.canvasId : null
  })
  const zoom = useClientState(workspaceId, (state) => (canvasId ? state.viewports[canvasId]?.zoom ?? 1 : 1))

  // ---- The xterm: built once per view ---------------------------------------

  useEffect(() => {
    const renderBox = renderBoxRef.current
    if (!renderBox) return
    const isMac = isMacKeyboard()
    const writeClipboard = clientUi().writeClipboard
    const xterm = createTerminalXterm({
      options: terminalOptions(terminalViewSettings()),
      theme: getActiveTheme().terminal,
      isMac,
      onUrl: createTerminalLinkHandler({
        target: () => terminalViewSettings().terminalLinkOpenTarget,
        remember: (target) => setTerminalViewSetting('terminalLinkOpenTarget', target),
        ask: (url) => clientUi().promptLinkOpen(url),
        openExternal: (url) => clientUi().openExternal(url),
        openInCate: (url) => { void sendRef.current({ kind: 'openUrl', url }).catch(() => {}) },
      }, isMac),
      fileLinks: {
        base: () => snapshotRef.current?.cwd ?? '',
        isFile: async (path) => (await fsClient(workspaceId).stat(path)).isFile,
        open: (path, line, column) => {
          void sendRef.current({
            kind: 'openFile',
            path,
            ...(line !== undefined ? { line } : {}),
            ...(column !== undefined ? { column } : {}),
          }).catch(() => {})
        },
      },
      ...(writeClipboard ? { clipboard: { writeText: (text: string) => writeClipboard(text) } } : {}),
    })
    xterm.open(renderBox)
    xtermRef.current = xterm
    const unregister = registerTerminalView(workspaceId, panelId, {
      fit: () => bindingRef.current?.fit(),
      resetRendering: () => xterm.resetRendering(),
    })
    const offTheme = subscribeTheme((theme) => xterm.setOptions({ theme: theme.terminal }))
    setReady(true)
    return () => {
      setReady(false)
      offTheme()
      unregister()
      xtermRef.current = null
      xterm.dispose()
    }
  }, [workspaceId, panelId])

  useEffect(() => { xtermRef.current?.setOptions(options) }, [options, ready])

  // ---- The byte stream: one binding per PTY -------------------------------

  const ptyId = snapshot?.ptyId ?? null
  useEffect(() => {
    const xterm = xtermRef.current
    if (!ready || !xterm || !ptyId || !processProxy) return
    const binding = bindTerminal({
      terminal: xterm.terminal,
      process: processProxy,
      id: ptyId,
      visible,
      ...grid.bindingOptions(xterm),
    })
    bindingRef.current = binding
    return () => {
      if (bindingRef.current === binding) bindingRef.current = null
      binding.dispose()
    }
    // `visible` is sent by its own effect; a new binding starts from the current value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ptyId, processProxy])

  useEffect(() => { bindingRef.current?.setVisible(visible) }, [visible, ptyId])

  // ---- Focus ----------------------------------------------------------------

  // Every focus call on this panel (becoming focused, or re-focused from its
  // tab or node while already focused: a new focus epoch) takes DOM focus and
  // holds it past the click that asked for it.
  useEffect(() => {
    const store = clientStateFor(workspaceId)
    if (!ready || !store) return
    const owns = () => store.getSnapshot().focusedPanelId === panelId
    const textarea = () => xtermRef.current?.terminal.textarea ?? xtermRef.current?.terminal.element
    let stop: (() => void) | null = null
    const run = () => {
      stop?.()
      stop = holdFocus(textarea, owns)
    }
    let epoch = store.getSnapshot().focusEpoch
    if (owns()) run()
    const off = store.subscribe(() => {
      const { focusEpoch } = store.getSnapshot()
      if (focusEpoch === epoch) return
      epoch = focusEpoch
      if (owns()) run()
      else { stop?.(); stop = null }
    })
    return () => { off(); stop?.() }
  }, [workspaceId, panelId, ready, ptyId])

  // ---- Crisp glyphs on a zoomed canvas ---------------------------------------
  // The canvas scales the view with CSS, which upscales xterm's glyph atlas.
  // Once the zoom settles on a higher step, render at base font x step and
  // counter-scale the render box by the measured cell ratio, so the grid
  // (and the PTY size) stays the same while glyphs come from a sharper atlas.

  const [renderScale, setRenderScale] = useState(1)
  const [cellScale, setCellScale] = useState({ w: 1, h: 1 })
  const baseCell = useRef<{ w: number; h: number; dpr: number } | null>(null)

  useEffect(() => { baseCell.current = null }, [options.fontSize])

  useEffect(() => {
    const target = snapRenderScale(zoom)
    if (target === renderScale) return
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => setRenderScale(target))
    })
    return () => cancelAnimationFrame(raf)
  }, [zoom, renderScale])

  useEffect(() => {
    const xterm = xtermRef.current
    const renderBox = renderBoxRef.current
    if (!ready || !xterm || !renderBox || renderBox.offsetParent === null) return
    const screen = xterm.terminal.element?.querySelector('.xterm-screen') as HTMLElement | null
    const { cols, rows } = xterm.terminal
    if (!screen || cols <= 0 || rows <= 0 || screen.offsetWidth <= 0) return
    const atBottom = xterm.isAtBottom()
    if (baseCell.current && baseCell.current.dpr !== window.devicePixelRatio) baseCell.current = null
    // The base cell can only be read at the base font: a scaled cell has
    // already lost its remainder to xterm's rounding.
    if (!baseCell.current && renderScale !== 1) {
      xterm.setOptions({ fontSize: options.fontSize })
      baseCell.current = { w: screen.offsetWidth / cols, h: screen.offsetHeight / rows, dpr: window.devicePixelRatio }
    }
    xterm.setOptions({ fontSize: options.fontSize * renderScale })
    const cellW = screen.offsetWidth / cols
    const cellH = screen.offsetHeight / rows
    if (renderScale === 1) baseCell.current = { w: cellW, h: cellH, dpr: window.devicePixelRatio }
    const base = baseCell.current
    const next = base ? { w: cellW / base.w, h: cellH / base.h } : { w: renderScale, h: renderScale }
    if (next.w > 0.5 && next.w < 3 && next.h > 0.5 && next.h < 3) setCellScale(next)
    if (atBottom) xterm.terminal.scrollToBottom()
  }, [ready, renderScale, options.fontSize])

  useEffect(() => { xtermRef.current?.syncScrollBarWidth() }, [cellScale])

  // The WebGL canvas comes up blank after the compositor re-rasterizes a
  // zoomed layer; repaint once the zoom settles.
  useEffect(() => {
    let raf = requestAnimationFrame(() => {
      raf = requestAnimationFrame(() => {
        const xterm = xtermRef.current
        if (!xterm || renderBoxRef.current?.offsetParent === null) return
        try { xterm.terminal.refresh(0, xterm.terminal.rows - 1) } catch { /* mid-dispose */ }
      })
    })
    return () => cancelAnimationFrame(raf)
  }, [zoom])

  // ---- The grid ----------------------------------------------------------------
  // The xterm has the PTY's grid; the panel's grid goes to the runtime
  // (parts/grid). Another view's grid is scaled or letterboxed into the panel.

  const grid = useTerminalGrid({
    ready,
    container: containerRef,
    xterm: xtermRef,
    binding: bindingRef,
    cellScale,
    busy: interacting,
    font: options,
  })
  const gridScale = grid.layout?.scale ?? 1

  // ---- Pointer coordinates ------------------------------------------------------
  // xterm hit-tests in DOM space but reads offsets from a rect the canvas zoom
  // and the grid scale transform: convert pointer coordinates back before
  // xterm sees them.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const adjust = (event: MouseEvent) => {
      const effective = (zoom * gridScale) / cellScale.w
      const effectiveY = (zoom * gridScale) / cellScale.h
      if (!shouldAdjustTerminalCoords(event.type, event.button, interacting(), effective, event.buttons)) return
      const screen = container.querySelector('.xterm-screen') as HTMLElement | null
      if (!screen) return
      const rect = screen.getBoundingClientRect()
      Object.defineProperty(event, 'clientX', { value: rect.left + (event.clientX - rect.left) / effective, configurable: true })
      Object.defineProperty(event, 'clientY', { value: rect.top + (event.clientY - rect.top) / effectiveY, configurable: true })
    }
    const types = ['mousedown', 'mousemove', 'mouseup'] as const
    for (const type of types) container.addEventListener(type, adjust, { capture: true })
    return () => { for (const type of types) container.removeEventListener(type, adjust, { capture: true }) }
  }, [zoom, cellScale, gridScale])

  // ---- Search -----------------------------------------------------------------

  const find = useCallback((value: string, direction: 'next' | 'previous' = 'next') => {
    const search = xtermRef.current?.search
    if (!search) return
    if (!value) search.clearDecorations()
    else if (direction === 'next') search.findNext(value)
    else search.findPrevious(value)
  }, [])

  const closeSearch = useCallback(() => {
    setShowSearch(false)
    setQuery('')
    find('')
    xtermRef.current?.terminal.focus()
  }, [find])

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'f') {
      event.preventDefault()
      setShowSearch(true)
    } else if (event.key === 'Escape' && showSearch) {
      closeSearch()
    }
  }, [showSearch, closeSearch])

  // ---- Drop ---------------------------------------------------------------------

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!isFileDrag(event.nativeEvent)) return
    // Keep the app's background handler from refusing the drop.
    event.stopPropagation()
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  // Pastes the dropped files' paths; files of another workspace or the OS
  // are copied into this checkout's `.cate/tmp` first.
  const onDrop = useCallback((event: React.DragEvent) => {
    const dropped = dropFilesInto({ workspaceId, near: snapshotRef.current?.cwd ?? undefined }, event.dataTransfer)
    if (!dropped) return
    event.preventDefault()
    event.stopPropagation()
    void dropped.then(({ paths, location }) => {
      if (paths.length === 0) return
      xtermRef.current?.terminal.paste(formatTerminalPaste(paths.map((path) => (location?.path === path ? { path, line: location.line } : { path }))))
    }, (error) => clientUi().showError(`Could not drop the files: ${error instanceof Error ? error.message : String(error)}`))
  }, [workspaceId])

  // ---- Failure ------------------------------------------------------------------

  const retry = useCallback(() => {
    if (retrying) return
    setRetrying(true)
    send({ kind: 'restart' }).catch(() => { /* the snapshot shows the new failure */ }).finally(() => setRetrying(false))
  }, [retrying, send])

  const failed = snapshot?.status === 'failed'
  // The PTY fits another view; only a live one can be fitted to this one.
  const fitElsewhere = snapshot?.status === 'running' ? grid.elsewhere : null

  return (
    <div className="relative w-full h-full flex flex-col" onKeyDown={onKeyDown}>
      {showSearch && (
        <div className="flex items-center gap-1 px-2 py-1 bg-surface-3 border-b border-subtle shrink-0">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              find(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') find(query, event.shiftKey ? 'previous' : 'next')
              if (event.key === 'Escape') closeSearch()
            }}
            className="flex-1 bg-surface-4 text-primary text-xs px-2 py-1 rounded-lg border border-subtle outline-none focus:border-focus"
            placeholder="Search terminal..."
          />
          <button type="button" onClick={() => find(query, 'previous')} className="text-secondary hover:text-primary text-xs px-1" title="Previous match (Shift+Enter)">↑</button>
          <button type="button" onClick={() => find(query, 'next')} className="text-secondary hover:text-primary text-xs px-1" title="Next match (Enter)">↓</button>
          <button type="button" onClick={closeSearch} className="text-secondary hover:text-primary text-xs px-1" title="Close (Escape)">✕</button>
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 relative min-h-0 overflow-hidden"
        data-filedrop="terminal"
        data-filedrop-id={panelId}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div
          ref={renderBoxRef}
          data-terminal-render-box=""
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: grid.layout ? `${grid.layout.width}px` : `${100 * cellScale.w}%`,
            height: grid.layout ? `${grid.layout.height}px` : `${100 * cellScale.h}%`,
            // Per axis: width and height round independently.
            transform: `scale(${gridScale / cellScale.w}, ${gridScale / cellScale.h})`,
            transformOrigin: '0 0',
            ['--cell-scale' as string]: String(cellScale.w),
          }}
        />
        {fitElsewhere && (
          <button
            type="button"
            onClick={() => bindingRef.current?.fit()}
            className="absolute bottom-2 right-3 z-40 px-2 py-0.5 rounded-md border border-subtle bg-surface-3/90 text-[11px] text-secondary hover:text-primary"
            title={`The terminal is ${fitElsewhere.cols}x${fitElsewhere.rows}, sized for another view. Fit it to this one.`}
          >
            Fit
          </button>
        )}
        {failed && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-surface-1/85 backdrop-blur-sm">
            <div className="max-w-md mx-6 rounded-lg border border-subtle bg-surface-3 p-4 text-center">
              <div className="text-[13px] font-semibold text-primary mb-1">Failed to start terminal</div>
              <div className="text-[12px] text-secondary mb-3 break-words whitespace-pre-wrap leading-snug">{snapshot?.error}</div>
              <button
                type="button"
                onClick={retry}
                disabled={retrying}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--focus-blue,#3b82f6)] text-white text-[12px] font-medium hover:brightness-110 disabled:opacity-60"
              >
                {retrying && <Spinner size={13} />}
                {retrying ? 'Restarting' : 'Retry'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

