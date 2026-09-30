// Runtime side of `tunnel.connect`. Bytes from the socket go to the client
// under the stream's credit window: the socket pauses while the client is
// behind. Bytes the client writes go to the socket.

import net from 'node:net'
import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, StreamSink } from '@kernel/rpc/runtime'
import { isLoopbackHost, type TunnelConnectParams, type TunnelEvent, type tunnelCapability } from '../contract'

export function validateTunnelTarget(params: TunnelConnectParams): { host: string; port: number } {
  const host = params?.host ?? '127.0.0.1'
  if (!isLoopbackHost(host)) throw new RpcError('rejected', `tunnel connects only to loopback, not ${String(host)}`)
  const port = params?.port
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RpcError('rejected', `invalid port ${String(port)}`)
  return { host, port }
}

export function tunnelCapabilityImpl(): CapabilityImpl<typeof tunnelCapability> {
  return {
    connect(params, sink: StreamSink<TunnelEvent, void>) {
      const { host, port } = validateTunnelTarget(params)
      const socket = net.connect({ host, port })
      let open = false
      socket.once('connect', () => {
        open = true
        sink.emit({ kind: 'open' })
      })
      socket.on('data', (chunk: Buffer) => {
        if (sink.bytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))) return
        socket.pause()
        void sink.drain().then(() => { if (!socket.destroyed) socket.resume() })
      })
      sink.onInput((bytes) => { if (!socket.destroyed) socket.write(bytes) })
      socket.on('error', (err) => {
        if (!open) sink.fail(new RpcError('gone', `cannot connect to ${host}:${port}: ${err.message}`))
      })
      socket.on('close', () => { if (!sink.ended) sink.end() })
      return () => { socket.destroy() }
    },
  }
}

