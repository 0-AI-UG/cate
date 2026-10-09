// Runtime side of `tunnel.connect`. Bytes from the socket go to the client
// under the stream's credit window: the socket pauses while the client is
// behind. Bytes the client writes go to the socket.

import type net from 'node:net'
import { RpcError } from '@kernel/rpc/contract'
import { connectLoopback } from '@runtime/transports/node'
import type { CapabilityImpl, StreamSink } from '@kernel/rpc/runtime'
import { isLoopbackHost, type TunnelConnectParams, type TunnelEvent, type tunnelCapability } from '../contract'

export function validateTunnelTarget(params: TunnelConnectParams): { host: string | undefined; port: number } {
  const host = params?.host
  if (host !== undefined && !isLoopbackHost(host)) throw new RpcError('rejected', `tunnel connects only to loopback, not ${String(host)}`)
  const port = params?.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RpcError('rejected', `invalid port ${String(port)}`)
  return { host, port }
}

export function tunnelCapabilityImpl(): CapabilityImpl<typeof tunnelCapability> {
  return {
    connect(params, sink: StreamSink<TunnelEvent, void>) {
      const { host, port } = validateTunnelTarget(params)
      let socket: net.Socket | null = null
      let cancelled = false
      connectLoopback(port, host).then((connected) => {
        socket = connected
        if (cancelled) { connected.destroy(); return }
        sink.emit({ kind: 'open' })
        connected.on('data', (chunk: Buffer) => {
          if (sink.bytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return
          connected.pause()
          void sink.drain().then(() => { if (!connected.destroyed) connected.resume() })
        })
        sink.onInput((bytes) => { if (!connected.destroyed) connected.write(bytes) })
        connected.on('error', () => { /* ends with close */ })
        connected.on('close', () => { if (!sink.ended) sink.end() })
      }, (err: Error) => {
        if (!cancelled) sink.fail(new RpcError('gone', `cannot connect to ${host ?? 'localhost'}:${port}: ${err.message}`))
      })
      return () => {
        cancelled = true
        socket?.destroy()
      }
    },
  }
}

