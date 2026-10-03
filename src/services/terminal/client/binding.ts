// Binds an xterm to a runtime terminal: attach, write the serialized screen,
// then the live output, and send keystrokes, sizes and activity back. The
// view owns everything else (links, search, keymaps, clipboard, rendering).
// Output is acknowledged once xterm has parsed it, so a slow view slows the
// stream instead of piling bytes up in memory.

import type { CapabilityProxy, Subscription } from '@kernel/rpc/contract'
import type { AttachEnd, AttachEvent, processCapability } from '../contract'

interface Disposable { dispose(): void }

/** The part of an xterm `Terminal` the binding uses (browser or headless). */
export interface XtermLike {
  readonly cols: number
  readonly rows: number
  write(data: string | Uint8Array, callback?: () => void): void
  reset(): void
  onData(listener: (data: string) => void): Disposable
  onBinary?(listener: (data: string) => void): Disposable
  onResize(listener: (size: { cols: number; rows: number }) => void): Disposable
}

export type ProcessProxy = Pick<CapabilityProxy<typeof processCapability>, 'attach' | 'view'>

export interface BindTerminalOptions {
  terminal: XtermLike
  process: ProcessProxy
  /** The runtime terminal id. */
  id: string
  visible?: boolean
  /** The size this view would fit, when it differs from its terminal's: a
   *  view that draws the PTY's grid (scaled into its frame) and reports the
   *  grid its frame holds. Report changes with `resized`. Default: the
   *  terminal's size, reported on its resizes. */
  size?: () => { cols: number; rows: number }
  /** The PTY's grid and whether it fits this view: before the screen is
   *  written, and on every change. */
  onSize?: (size: { cols: number; rows: number; fitted: boolean }) => void
  /** The PTY exited; the screen stays. */
  onExit?: (code: number) => void
  /** The attach failed (the terminal is gone, the connection refused). */
  onError?: (error: unknown) => void
}

export interface TerminalBinding {
  /** This viewer's id once attached. */
  readonly viewer: string | null
  /** Fits the PTY to this view; it then follows this view's resizes. */
  fit(): void
  /** The view's `size` changed. */
  resized(): void
  setVisible(visible: boolean): void
  dispose(): void
}

export function bindTerminal(options: BindTerminalOptions): TerminalBinding {
  const { terminal, process: proc, id } = options
  const size = options.size ?? (() => ({ cols: terminal.cols, rows: terminal.rows }))
  const encoder = new TextEncoder()
  let visible = options.visible !== false
  let viewer: string | null = null
  // `fit` before the attach answers: sent with the first view report.
  let pendingFit = false
  let fitted = false
  let sub: Subscription<AttachEvent, AttachEnd> | null = null
  let disposed = false

  const view = (extra: { fit?: boolean } = {}): void => {
    if (!viewer || disposed) return
    proc.view({ id, viewer, ...size(), visible, ...extra }).catch(() => {})
  }

  const attach = (): void => {
    viewer = null
    // `resume` re-opens the attach after a reconnect; it starts with a fresh
    // screen, so nothing is lost or doubled.
    const current = proc.attach({ id, ...size(), visible }, { manualAck: true, resume: true })
    sub = current
    current.onEvent((event) => {
      if (event.kind === 'screen') {
        viewer = event.viewer
        options.onSize?.({ cols: event.cols, rows: event.rows, fitted })
        terminal.reset()
        if (event.data) terminal.write(event.data)
        // The view may have been resized while the attach was in flight.
        view(pendingFit ? { fit: true } : {})
        pendingFit = false
      } else if (event.kind === 'size') {
        fitted = event.fitted
        options.onSize?.({ cols: event.cols, rows: event.rows, fitted })
      } else if (event.kind === 'exit') {
        options.onExit?.(event.code)
      }
    })
    current.onBytes((bytes) => terminal.write(bytes, () => current.ack(bytes.length)))
    current.done.then(
      (end) => { if (end?.reason === 'lagged' && !disposed && sub === current) attach() },
      (error) => { if (!disposed && sub === current) options.onError?.(error) },
    )
  }

  const send = (data: string): void => { sub?.write(encoder.encode(data)) }
  const subscriptions = [
    terminal.onData(send),
    // With its own `size`, the terminal's resizes are the PTY's, not the view's.
    ...(options.size ? [] : [terminal.onResize(() => view())]),
    ...(terminal.onBinary ? [terminal.onBinary(send)] : []),
  ]

  attach()

  return {
    get viewer() { return viewer },
    fit() {
      if (viewer) view({ fit: true })
      else pendingFit = true
    },
    resized: () => view(),
    setVisible(next) {
      if (next === visible) return
      visible = next
      view()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const s of subscriptions) s.dispose()
      sub?.cancel()
      sub = null
    },
  }
}
