// Binds an xterm to a runtime terminal: attach, write the serialized screen,
// then the live output, and send keystrokes, visibility and fits back. The
// view owns everything else (links, search, keymaps, clipboard, rendering).
// Output is acknowledged once xterm has parsed it, so a slow view slows the
// stream instead of piling bytes up in memory.

import type { CapabilityProxy, Subscription } from '@kernel/rpc/contract'
import type { AttachEnd, AttachEvent, processCapability } from '../contract'

// xterm 5.5 keeps a UTF-32 scratch buffer sized to its largest write. Bound
// each parser input so a large attach snapshot doesn't permanently grow it.
const WRITE_CHUNK_SIZE = 16 * 1024

function writeTerminal(terminal: XtermLike, data: string | Uint8Array, callback?: () => void): void {
  if (data.length === 0) {
    terminal.write(data, callback)
    return
  }
  for (let offset = 0; offset < data.length; offset += WRITE_CHUNK_SIZE) {
    const end = offset + WRITE_CHUNK_SIZE
    const chunk = typeof data === 'string' ? data.slice(offset, end) : data.subarray(offset, end)
    terminal.write(chunk, end >= data.length ? callback : undefined)
  }
}

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
  /** Replace the attach with an authoritative snapshot at this history limit.
   * Resolves after the replacement screen is parsed. */
  setScrollback(scrollback: number, beforeReset?: () => void): Promise<void>
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
  let scrollback = options.scrollback
  let replacement: { promise: Promise<void>; resolve(): void; reject(error: unknown): void; beforeReset?: () => void } | null = null
  let screenEpoch = 0

  const view = (): void => {
    if (!viewer || disposed) return
    proc.view({ id, viewer, visible }).catch(() => {})
  }

  const attach = (): void => {
    sub?.cancel()
    viewer = null
    // `resume` re-opens the attach after a reconnect; it starts with a fresh
    // screen, so nothing is lost or doubled.
    const current = proc.attach({ id, visible, ...(scrollback !== undefined ? { scrollback } : {}) }, { manualAck: true, resume: true })
    sub = current
    let waitingForReset = false
    let pending: Array<Uint8Array | { cols: number; rows: number }> = []
    const live = (bytes: Uint8Array): void => {
      const epoch = screenEpoch
      writeTerminal(terminal, bytes, () => {
        if (!disposed && sub === current && epoch === screenEpoch) current.ack(bytes.length)
      })
    }
    const size = (next: { cols: number; rows: number }): void => {
      const epoch = screenEpoch
      terminal.write('', () => {
        if (!disposed && sub === current && epoch === screenEpoch) options.onSize?.(next)
      })
    }
    current.onEvent((event) => {
      if (disposed || sub !== current) return
      if (event.kind === 'screen') {
        viewer = event.viewer
        const epoch = ++screenEpoch
        waitingForReset = true
        pending = []
        // Drain writes belonging to the previous attach before resetting. New
        // bytes stay behind this barrier and remain bounded by manual ACKs.
        terminal.write('', () => {
          if (disposed || sub !== current || epoch !== screenEpoch) return
          options.onSize?.({ cols: event.cols, rows: event.rows })
          replacement?.beforeReset?.()
          terminal.reset()
          writeTerminal(terminal, event.data, () => {
            if (disposed || sub !== current || epoch !== screenEpoch) return
            replacement?.resolve()
            replacement = null
          })
          waitingForReset = false
          for (const item of pending) { if (item instanceof Uint8Array) live(item); else size(item) }
          pending = []
        })
        // The view may have been hidden while the attach was in flight.
        view()
      } else if (event.kind === 'size') {
        const next = { cols: event.cols, rows: event.rows }
        if (waitingForReset) pending.push(next)
        else size(next)
      } else if (event.kind === 'exit') {
        options.onExit?.(event.code)
      }
    })
    current.onBytes((bytes) => {
      if (disposed || sub !== current) return
      if (waitingForReset) pending.push(bytes)
      else live(bytes)
    })
    current.done.then(
      (end) => { if (end?.reason === 'lagged' && !disposed && sub === current) attach() },
      (error) => {
        if (disposed || sub !== current) return
        replacement?.reject(error)
        replacement = null
        options.onError?.(error)
      },
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
    setScrollback(next, beforeReset) {
      if (disposed) return Promise.reject(new Error('Terminal binding disposed'))
      if (replacement && scrollback === next) return replacement.promise
      replacement?.reject(new Error('Terminal snapshot superseded'))
      scrollback = next
      let resolve!: () => void
      let reject!: (error: unknown) => void
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
      replacement = { promise, resolve, reject, beforeReset }
      attach()
      return promise
    },
    setVisible(next) {
      if (next === visible) return
      visible = next
      view()
    },
    dispose() {
      if (disposed) return
      disposed = true
      replacement?.reject(new Error('Terminal binding disposed'))
      replacement = null
      for (const s of subscriptions) s.dispose()
      sub?.cancel()
      sub = null
    },
  }
}
