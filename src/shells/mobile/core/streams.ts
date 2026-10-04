// Loopback routing for the app's web views (`loopback.port`, `stream.*`,
// architecture 12.3). WebKit connects to loopback hosts directly, never
// through a proxy, so the app listens on this phone's loopback at each
// runtime port a page needs (a socket listener is a native primitive) and
// opens a stream per connection: the runtime's machine, reached through the
// workspace connection's `dialLoopback(port)`. Bytes cross as base64, in
// order: the next chunk goes once the app took the last.

import type { ByteDuplex } from '@kernel/rpc/contract'
import { isLoopbackHostname } from '@runtime/tunnel/contract'
import { base64ToBytes, bytesToBase64 } from '@workspace/files/contract'
import type { MobileBridge } from '../contract'
import type { MobileClient } from './boot'

interface OpenStream {
  write(data: string): void
  close(): void
}

export interface MobileStreams {
  open(params: { streamId: string; workspaceId: string; port: number }): Promise<void>
  get(streamId: string): OpenStream | undefined
}

/** The runtime port a page at `url` needs forwarded: its port when its host
 *  is loopback (the runtime's machine on every client), else null. */
export function loopbackPort(url: string): number | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    || !isLoopbackHostname(parsed.hostname)) return null
  if (parsed.port) return Number(parsed.port)
  return parsed.protocol === 'https:' || parsed.protocol === 'wss:' ? 443 : 80
}

/** Chunks waiting for the app, sent one at a time and merged meanwhile. */
function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export function createMobileStreams(client: MobileClient, bridge: MobileBridge): MobileStreams {
  const open = new Map<string, OpenStream>()

  return {
    async open({ streamId, workspaceId, port }) {
      const connection = client.connections.get(workspaceId)
      if (!connection) throw new Error('The workspace is not connected.')
      const duplex: ByteDuplex = await connection.dialLoopback(port)
      let ended = false
      let queue: Uint8Array[] = []
      let sending = false
      const pump = async () => {
        if (sending) return
        sending = true
        while (queue.length > 0) {
          const chunk = concat(queue)
          queue = []
          await bridge('stream.event', { streamId, kind: 'data', data: bytesToBase64(chunk) }).catch(() => {})
        }
        sending = false
        if (ended) void bridge('stream.event', { streamId, kind: 'end' }).catch(() => {})
      }
      duplex.onData((bytes) => {
        queue.push(bytes)
        void pump()
      })
      duplex.onClose(() => {
        if (ended) return
        ended = true
        open.delete(streamId)
        if (!sending) void pump()
      })
      open.set(streamId, {
        write: (data) => duplex.write(base64ToBytes(data)),
        close() {
          ended = true
          open.delete(streamId)
          duplex.close()
        },
      })
    },
    get: (streamId) => open.get(streamId),
  }
}
