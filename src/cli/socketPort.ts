// The CLI's connection to its workspace runtime: the local socket (a named
// pipe on Windows) speaking the runtime protocol, identified by the caller
// token in `hello`.

import net from 'node:net'
import { framePortOver, IncompatibleProtocolError, type ByteDuplex } from '@kernel/rpc/contract'
import { RpcClient, createCapabilityProxy } from '@kernel/rpc/client'
import { apiCapability } from '@kernel/api/contract'
import { EnvError, type ApiCallPort } from './engine'

function socketDuplex(socket: net.Socket): ByteDuplex {
  return {
    write: (bytes) => { socket.write(bytes) },
    onData: (listener) => {
      socket.on('data', (chunk: Buffer) => listener(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)))
    },
    onClose: (listener) => {
      let reason: string | undefined
      socket.on('error', (err) => { reason = err.message })
      socket.on('close', () => listener(reason))
    },
    close: () => { socket.destroy() },
  }
}

export function connectSocket(socketPath: string, token: string, version: string): ApiCallPort {
  const socket = net.createConnection(socketPath)
  const client = new RpcClient({ version, identity: { caller: { token } } })
  const ready = client.attach(framePortOver(socketDuplex(socket), 'stream'))
  ready.catch(() => {})
  const api = createCapabilityProxy(client, apiCapability)
  return {
    async call(method, args, timeoutMs) {
      try {
        await ready
      } catch (err) {
        throw new EnvError(`cannot reach the workspace runtime at ${socketPath}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (client.state === 'incompatible') {
        const remote = client.remote
        throw new EnvError(new IncompatibleProtocolError(client.protocol, remote?.protocol ?? [0, 0], remote?.version ?? 'unknown').message)
      }
      return api.call({ method, args }, { timeoutMs })
    },
    close() {
      client.close()
      socket.destroy()
    },
  }
}
