// A kernel/rpc byte pipe over one Electron MessagePort (architecture 15: one
// port per duplex, no per-feature IPC). The renderer end speaks the same
// messages (`../contract/pipe.ts`).

import type { ByteDuplex } from '@kernel/rpc/contract'
import { isPipeControl, pipeBytes, type PipeMessage } from '../contract'

/** The part of Electron's `MessagePortMain` a pipe uses. */
export interface MainPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

/** Connects a byte pipe to a port: bytes both ways, close both ways. */
export function bridgePipe(duplex: ByteDuplex, port: MainPort): void {
  let closed = false
  const finish = (reason?: string, notify = true) => {
    if (closed) return
    closed = true
    if (notify) {
      try { port.postMessage({ t: 'close', ...(reason ? { reason } : {}) } satisfies PipeMessage) } catch { /* gone */ }
    }
    try { port.close() } catch { /* gone */ }
  }
  duplex.onData((bytes) => { if (!closed) port.postMessage(bytes) })
  duplex.onClose((reason) => finish(reason))
  port.on('message', ({ data }) => {
    if (closed) return
    const bytes = pipeBytes(data)
    if (bytes) {
      duplex.write(bytes)
      return
    }
    if (isPipeControl(data) && data.t === 'close') {
      finish(undefined, false)
      duplex.close(data.reason)
    }
  })
  port.on('close', () => {
    if (closed) return
    finish(undefined, false)
    duplex.close('pipe closed')
  })
  port.start()
}

/** The byte pipe of a port whose far end (a renderer) dials something and
 *  answers `open` or `close`. Resolves once open. */
export function awaitPortPipe(port: MainPort, timeoutMs = 15_000): Promise<ByteDuplex> {
  return new Promise((resolve, reject) => {
    let state: 'pending' | 'open' | 'closed' = 'pending'
    const dataListeners: ((bytes: Uint8Array) => void)[] = []
    const closeListeners: ((reason?: string) => void)[] = []
    const early: Uint8Array[] = []
    const end = (reason?: string) => {
      if (state === 'closed') return
      const wasOpen = state === 'open'
      state = 'closed'
      clearTimeout(timer)
      try { port.close() } catch { /* gone */ }
      if (!wasOpen) reject(new Error(reason ?? 'pipe closed before it opened'))
      for (const listener of closeListeners) listener(reason)
    }
    const timer = setTimeout(() => end('timed out waiting for the renderer'), timeoutMs)
    const duplex: ByteDuplex = {
      write: (bytes) => { if (state === 'open') port.postMessage(bytes) },
      onData: (listener) => {
        dataListeners.push(listener)
        for (const bytes of early.splice(0)) listener(bytes)
      },
      onClose: (listener) => { closeListeners.push(listener) },
      close: (reason) => {
        if (state === 'closed') return
        try { port.postMessage({ t: 'close', ...(reason ? { reason } : {}) } satisfies PipeMessage) } catch { /* gone */ }
        end(reason)
      },
    }
    port.on('message', ({ data }) => {
      if (state === 'closed') return
      const bytes = pipeBytes(data)
      if (bytes) {
        if (dataListeners.length === 0) early.push(bytes)
        else for (const listener of dataListeners) listener(bytes)
        return
      }
      if (!isPipeControl(data)) return
      if (data.t === 'open' && state === 'pending') {
        state = 'open'
        clearTimeout(timer)
        resolve(duplex)
      } else if (data.t === 'close') {
        end(data.reason)
      }
    })
    port.on('close', () => end('pipe closed'))
    port.start()
  })
}
