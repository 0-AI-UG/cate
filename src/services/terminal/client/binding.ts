// Binds an xterm to a runtime terminal: attach, write the serialized screen,
// then the live output, and send keystrokes, visibility and fits back. The
// view owns everything else (links, search, keymaps, clipboard, rendering).
// Output is acknowledged once xterm has parsed it, so a slow view slows the
// stream instead of piling bytes up in memory.

import type { CapabilityProxy, Subscription } from '@kernel/rpc/contract'
import type { AttachEnd, AttachEvent, processCapability } from '../contract'

interface Disposable { dispose(): void }

/** The part of an xterm `Terminal` the binding uses (browser or headless). */
export interface XtermLike {
  write(data: string | Uint8Array, callback?: () => void): void
  reset(): void
  onData(listener: (data: string) => void): Disposable
  onBinary?(listener: (data: string) => void): Disposable
}

export type ProcessProxy = Pick<CapabilityProxy<typeof processCapability>, 'attach' | 'view' | 'fit'>

export interface BindTerminalOptions {
  terminal: XtermLike
  process: ProcessProxy
  /** The runtime terminal id. */
  id: string
  visible?: boolean
  /** The most scrollback lines this view keeps; the attach's screen carries
   *  no more. Default: all of it. */
  scrollback?: number
  /** The PTY's grid: before the screen is written, and on every change. */
  onSize?: (size: { cols: number; rows: number }) => void
  /** The PTY exited; the screen stays. */
  onExit?: (code: number) => void
  /** The attach failed (the terminal is gone, the connection refused). */
  onError?: (error: unknown) => void
}

export interface TerminalBinding {
  /** This viewer's id once attached. */
  readonly viewer: string | null
  /** Sizes the PTY to the grid this view holds, so it shows it whole. The
   *  PTY's size changes only through a fit. */
  fit(size: { cols: number; rows: number }): void
  setVisible(visible: boolean): void
  dispose(): void
}

export function bindTerminal(options: BindTerminalOptions): TerminalBinding {
  const { terminal, process: proc, id } = options
  const encoder = new TextEncoder()
  let visible = options.visible !== false
  let viewer: string | null = null
  let sub: Subscription<AttachEvent, AttachEnd> | null = null
  let disposed = false

  const view = (): void => {
    if (!viewer || disposed) return
    proc.view({ id, viewer, visible }).catch(() => {})
  }

  const attach = (): void => {
    viewer = null
    // `resume` re-opens the attach after a reconnect; it starts with a fresh
    // screen, so nothing is lost or doubled.
    const current = proc.attach({ id, visible, ...(options.scrollback !== undefined ? { scrollback: options.scrollback } : {}) }, { manualAck: true, resume: true })
    sub = current
    current.onEvent((event) => {
      if (event.kind === 'screen') {
        viewer = event.viewer
        options.onSize?.({ cols: event.cols, rows: event.rows })
        terminal.reset()
        if (event.data) terminal.write(event.data)
        // The view may have been hidden while the attach was in flight.
        view()
      } else if (event.kind === 'size') {
        options.onSize?.({ cols: event.cols, rows: event.rows })
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
    ...(terminal.onBinary ? [terminal.onBinary(send)] : []),
  ]

  attach()

  return {
    get viewer() { return viewer },
    fit(size) {
      if (disposed) return
      proc.fit({ id, cols: size.cols, rows: size.rows }).catch(() => {})
    },
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
