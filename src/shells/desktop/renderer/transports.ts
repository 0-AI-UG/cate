// The renderer end of the desktop transport IPC: `ShellTransports` for
// client/connections over the pipes main hands out, and the server side of
// main's loopback web proxy (each request becomes `connection.dialLoopback`).

import type { ByteDuplex } from '@kernel/rpc/contract'
import type { ShellTransports, WorkspaceConnection } from '@client/connections'
import type { DesktopApi } from '../contract'
import { isPipeControl } from '../contract'

declare global {
  interface Window {
    cateDesktop: DesktopApi
  }
}

/** A pipe from main as a kernel/rpc byte pipe. */
export function pipeDuplex(pipes: DesktopApi['pipes'], pipe: string): ByteDuplex {
  const dataListeners: ((bytes: Uint8Array) => void)[] = []
  const closeListeners: ((reason?: string) => void)[] = []
  const pending: Uint8Array[] = []
  let closed = false
  const finish = (reason?: string) => {
    if (closed) return
    closed = true
    off()
    for (const listener of closeListeners) listener(reason)
  }
  const off = pipes.onMessage(pipe, (message) => {
    if (message instanceof Uint8Array) {
      if (dataListeners.length === 0) pending.push(message)
      else for (const listener of dataListeners) listener(message)
    } else if (isPipeControl(message) && message.t === 'close') {
      finish(message.reason)
    }
  })
  return {
    write: (bytes) => { if (!closed) pipes.write(pipe, bytes) },
    onData(listener) {
      dataListeners.push(listener)
      for (const bytes of pending.splice(0)) listener(bytes)
    },
    onClose: (listener) => { closeListeners.push(listener) },
    close(reason) {
      if (closed) return
      pipes.close(pipe, reason)
      finish(reason)
    },
  }
}

export function createDesktopShellTransports(api: DesktopApi = window.cateDesktop): ShellTransports {
  return {
    dialLocal: async (root) => pipeDuplex(api.pipes, await api.transports.dialLocal(root)),
    dialMachine: async (machine, root) => pipeDuplex(api.pipes, await api.transports.dialMachine(machine, root)),
    dialNetwork: async (target) => pipeDuplex(api.pipes, await api.transports.dialNetwork(target)),
    dialLoopbackTcp: async (port) => pipeDuplex(api.pipes, await api.transports.dialLoopbackTcp(port)),
    // Main pairs: the device key never enters the renderer.
    pair: (link) => api.transports.pair({ link }),
  }
}

/** Answers main's loopback requests with this window's connections. Call once
 *  per window; `connectionFor` maps a runtime id to its open connection. */
export function serveLoopbackRequests(
  connectionFor: (runtimeId: string) => Pick<WorkspaceConnection, 'dialLoopback'> | undefined,
  api: DesktopApi = window.cateDesktop,
): () => void {
  return api.transports.onLoopbackRequest(({ runtimeId, port, pipe }) => {
    const connection = connectionFor(runtimeId)
    if (!connection) {
      api.pipes.close(pipe, `not connected to runtime ${runtimeId}`)
      return
    }
    connection.dialLoopback(port).then((duplex) => {
      const toMain = pipeDuplex(api.pipes, pipe)
      api.pipes.open(pipe)
      duplex.onData((bytes) => toMain.write(bytes))
      toMain.onData((bytes) => duplex.write(bytes))
      duplex.onClose((reason) => toMain.close(reason))
      toMain.onClose((reason) => duplex.close(reason))
    }, (error: unknown) => {
      api.pipes.close(pipe, error instanceof Error ? error.message : String(error))
    })
  })
}
