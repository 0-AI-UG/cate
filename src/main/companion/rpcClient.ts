// =============================================================================
// CompanionRpcClient — the main-process half. Writes `req` frames, correlates
// `res` frames by id, dispatches `evt` frames to per-streamId listeners, and
// resolves a `ready` promise on the daemon's `hello`. Transport-agnostic: it is
// handed a `write` function and fed input chunks, so the same client sits on a
// local child process, an SSH exec channel, or wsl.exe stdio.
// =============================================================================

import { FrameDecoder, serializeFrame } from '../../companion/jsonl'
import type { HelloFrame } from '../../companion/protocol'

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout> | null
}

export interface CompanionRpcClientOptions {
  requestTimeoutMs?: number
  /** Timeout for the initial handshake. */
  helloTimeoutMs?: number
}

export class CompanionRpcClient {
  private readonly decoder: FrameDecoder
  private readonly pending = new Map<number, Pending>()
  private readonly streams = new Map<string, (payload: unknown) => void>()
  private nextId = 1
  private disposed = false

  private helloFrame: HelloFrame | null = null
  readonly ready: Promise<HelloFrame>
  private resolveReady!: (h: HelloFrame) => void
  private rejectReady!: (err: Error) => void
  private helloTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly write: (line: string) => void,
    private readonly opts: CompanionRpcClientOptions = {},
  ) {
    this.ready = new Promise<HelloFrame>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    // Swallow unhandled rejection if nobody awaits `ready` before a failure.
    this.ready.catch(() => { /* surfaced to callers that await it */ })
    const helloTimeout = opts.helloTimeoutMs ?? 10_000
    this.helloTimer = setTimeout(() => {
      this.rejectReady(new Error('Companion handshake timed out'))
    }, helloTimeout)

    this.decoder = new FrameDecoder((frame) => {
      if (frame.t === 'hello') {
        this.helloFrame = frame
        if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null }
        this.resolveReady(frame)
      } else if (frame.t === 'res') {
        const p = this.pending.get(frame.id)
        if (!p) return
        this.pending.delete(frame.id)
        if (p.timer) clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.data)
        else p.reject(new Error(frame.error))
      } else if (frame.t === 'evt') {
        this.streams.get(frame.streamId)?.(frame.payload)
      }
    })
  }

  get hello(): HelloFrame | null {
    return this.helloFrame
  }

  /** Feed raw bytes from the transport. */
  handleChunk(chunk: string | Buffer): void {
    this.decoder.push(chunk)
  }

  /** Issue a request and await its response. */
  call(method: string, params: unknown[] = []): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('Companion connection is closed'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Companion request "${method}" timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.write(serializeFrame({ t: 'req', id, method, params }))
      } catch (err) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  registerStream(streamId: string, onPayload: (payload: unknown) => void): void {
    this.streams.set(streamId, onPayload)
  }

  unregisterStream(streamId: string): void {
    this.streams.delete(streamId)
  }

  /** Reject every in-flight request and stop accepting new ones. */
  dispose(reason = 'Companion connection closed'): void {
    if (this.disposed) return
    this.disposed = true
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null }
    this.rejectReady(new Error(reason))
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(reason))
    }
    this.pending.clear()
    this.streams.clear()
  }
}
