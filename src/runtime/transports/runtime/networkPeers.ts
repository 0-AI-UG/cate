// Every network connection, whatever carried it, goes through here: the
// Noise handshake and the pairing policy (runtime/security), then the rpc
// frames. The `hello` must name the device key the handshake proved, and
// revoking a device drops its connections, those still in their handshake
// included (architecture 7.6).

import { RpcError, toWireError, type Frame, type FramePort, type HelloMessage } from '@kernel/rpc/contract'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import { bytesToHex, type KeyPair, type MessagePortLike, type SecureChannel } from '../../security/contract'
import { acceptPeer, type PeerPolicy } from '../../security/runtime'
import { secureFramePort, type UnpairedRefusal } from '../contract'

export interface NetworkPairing extends PeerPolicy {
  /** Called with the hex public key of a removed device. */
  onRevoked(listener: (publicKey: string) => void): () => void
}

export interface NetworkPeersOptions {
  rpc: RpcServer
  runtimeKeys: KeyPair
  pairing: NetworkPairing
  log?: Logger
  handshakeTimeoutMs?: number
  /** Connections not yet proven paired, per transport, so one transport's
   *  unproven peers (anyone can reach Cate Connect) never lock out another.
   *  Default 32. */
  maxUnproven?: number
  /** Of those, from one remote address. Default 4. */
  maxUnprovenPerSource?: number
}

/** What carried a connection in. */
export type NetworkTransport = 'sameNetwork' | 'cateConnect'

export interface ConnectionSource {
  transport: NetworkTransport
  /** The remote address, where the transport knows one. */
  address?: string
}

export interface NetworkPeers {
  /** Secures and serves one incoming connection. Resolves once it is served
   *  or refused; a refusal closes the port. */
  accept(port: MessagePortLike, from: ConnectionSource): Promise<void>
  /** Live connections by device (hex public key). */
  connected(): string[]
  /** Drops the connections one transport carried, live or still in their
   *  handshake (that transport was turned off). */
  close(transport: NetworkTransport): void
  /** Drops every network connection (network access turned off). */
  closeAll(): void
  dispose(): void
}

export function createNetworkPeers(options: NetworkPeersOptions): NetworkPeers {
  const live = new Map<SecureChannel, { key: string; transport: NetworkTransport }>()
  const maxUnproven = options.maxUnproven ?? 32
  const maxPerSource = options.maxUnprovenPerSource ?? 4
  // Connections between accept and a proven key, by transport and by source.
  const unproven = new Map<MessagePortLike, NetworkTransport>()
  const unprovenBySource = new Map<string, number>()
  const unprovenOn = (transport: NetworkTransport) => [...unproven.values()].filter((t) => t === transport).length

  const offRevoked = options.pairing.onRevoked((publicKey) => {
    for (const [channel, entry] of live) {
      if (entry.key === publicKey) channel.close(new Error('device removed'))
    }
  })

  return {
    async accept(port, from) {
      const source = from.address
      const fromSource = source === undefined ? 0 : unprovenBySource.get(source) ?? 0
      if (unprovenOn(from.transport) >= maxUnproven || fromSource >= maxPerSource) {
        options.log?.info('refused a network connection: too many unpaired connections')
        port.close()
        return
      }
      unproven.set(port, from.transport)
      if (source !== undefined) unprovenBySource.set(source, fromSource + 1)
      let channel: SecureChannel
      try {
        channel = await acceptPeer(port, {
          runtimeKeys: options.runtimeKeys,
          policy: options.pairing,
          handshakeTimeoutMs: options.handshakeTimeoutMs,
          refuse: (unpaired) => refuse(unpaired, options.rpc),
        })
      } catch (error) {
        options.log?.info('refused a network connection: %s', (error as Error).message)
        return
      } finally {
        unproven.delete(port)
        if (source !== undefined) {
          const left = (unprovenBySource.get(source) ?? 1) - 1
          if (left > 0) unprovenBySource.set(source, left)
          else unprovenBySource.delete(source)
        }
      }
      const key = bytesToHex(channel.remoteStatic)
      // A revoke can land while the handshake runs.
      if (!(await options.pairing.isPaired(channel.remoteStatic))) {
        refuse(channel, options.rpc)
        channel.close(new Error('device removed'))
        return
      }
      live.set(channel, { key, transport: from.transport })
      channel.onClose(() => live.delete(channel))
      options.rpc.serve(checkedHello(secureFramePort(channel), key, options.rpc))
    },
    connected: () => [...live.values()].map((entry) => entry.key),
    close(transport) {
      for (const [port, carried] of [...unproven]) if (carried === transport) port.close()
      for (const [channel, entry] of [...live]) {
        if (entry.transport === transport) channel.close(new Error('network access turned off'))
      }
    },
    closeAll() {
      for (const port of [...unproven.keys()]) port.close()
      for (const channel of [...live.keys()]) channel.close(new Error('network access turned off'))
    },
    dispose() {
      offRevoked()
      this.closeAll()
    },
  }
}

/**
 * Answers an unpaired (never paired or removed) device's hello with a
 * refusal, so its client stops retrying and says why. It names no version:
 * an unpaired peer learns nothing about the runtime.
 */
function refuse(channel: SecureChannel, rpc: RpcServer): void {
  secureFramePort(channel).send({
    kind: 'msg',
    msg: {
      t: 'hello',
      protocol: rpc.protocol,
      version: '',
      error: toWireError(new RpcError('rejected', 'This device is not paired with this workspace.', { unpaired: true } satisfies UnpairedRefusal)),
    },
  })
}

/**
 * Refuses a `hello` that is not a client naming the key this connection
 * proved. A caller token has no business on a network connection.
 */
function checkedHello(port: FramePort, publicKey: string, rpc: RpcServer): FramePort {
  let checked = false
  return {
    send: (frame) => port.send(frame),
    close: (reason) => port.close(reason),
    onClose: (listener) => port.onClose(listener),
    onFrame(listener) {
      port.onFrame((frame: Frame) => {
        if (!checked && frame.kind === 'msg' && frame.msg.t === 'hello') {
          const hello = frame.msg as HelloMessage
          if (hello.caller || hello.client?.device?.publicKey !== publicKey) {
            port.send({
              kind: 'msg',
              msg: {
                t: 'hello',
                protocol: rpc.protocol,
                version: rpc.opts.version,
                error: toWireError(new RpcError('rejected', 'hello does not match the device key of this connection')),
              },
            })
            port.close('device key mismatch')
            return
          }
          checked = true
        }
        listener(frame)
      })
    },
  }
}
