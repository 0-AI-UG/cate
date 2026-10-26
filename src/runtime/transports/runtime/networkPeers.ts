// Every network connection, whatever carried it, goes through here: the
// Noise handshake (runtime/security), the opening that says what the device
// wants (runtime/pairing admits it), then the rpc frames. The `hello` must
// name the device key the handshake proved, and revoking a device drops its
// connections, those still in their handshake included (architecture 7.6).

import { RpcError, toWireError, type Frame, type FramePort, type HelloMessage } from '@kernel/rpc/contract'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import { bytesToHex, DEFAULT_MAX_FRAME, nextFrame, type KeyPair, type MessagePortLike, type SecureChannel } from '../../security/contract'
import { acceptPeer } from '../../security/runtime'
import { OPENING_TIMEOUT_MS, type Admission } from '../../pairing/contract'
import { secureFramePort, type UnpairedRefusal } from '../contract'

export interface NetworkPairing {
  /** Reads the connection's opening and acts on it. */
  admit(channel: SecureChannel): Promise<Admission>
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
  // Connections between accept and their admission, by transport and by source.
  const unproven = new Map<MessagePortLike, NetworkTransport>()
  const unprovenBySource = new Map<string, number>()
  const unprovenOn = (transport: NetworkTransport) => [...unproven.values()].filter((t) => t === transport).length

  const offRevoked = options.pairing.onRevoked((publicKey) => {
    for (const [channel, entry] of live) {
      if (entry.key === publicKey) channel.close(new Error('device removed'))
    }
  })

  const serve = (channel: SecureChannel, transport: NetworkTransport) => {
    const key = bytesToHex(channel.remoteStatic)
    channel.setMaxFrameBytes(DEFAULT_MAX_FRAME)
    live.set(channel, { key, transport })
    channel.onClose(() => live.delete(channel))
    options.rpc.serve(checkedHello(secureFramePort(channel), key, options.rpc))
  }

  /** Ends a connection that is not served, saying why in the log. */
  const turnAway = async (channel: SecureChannel, admission: Exclude<Admission, { kind: 'connect' }>) => {
    switch (admission.kind) {
      case 'unpaired':
        options.log?.info('refused a device that is not paired')
        await refuse(channel)
        break
      case 'paired':
        options.log?.info('paired device "%s"', admission.deviceName)
        break
      case 'pair-rejected':
        options.log?.info('refused pairing: %s', admission.reason)
        break
      case 'no-opening':
        options.log?.info('refused a network connection: no opening')
        break
    }
    // The peer hangs up once it has read the answer. Closing first can drop
    // the answer still buffered in the transport (a WebRTC data channel).
    if (admission.kind !== 'no-opening') await peerHangsUp(channel)
    channel.close()
  }

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
      try {
        const channel = await acceptPeer(port, { runtimeKeys: options.runtimeKeys, handshakeTimeoutMs: options.handshakeTimeoutMs })
        const admission = await options.pairing.admit(channel)
        if (admission.kind === 'connect') serve(channel, from.transport)
        else await turnAway(channel, admission)
      } catch (error) {
        options.log?.info('refused a network connection: %s', (error as Error).message)
      } finally {
        unproven.delete(port)
        if (source !== undefined) {
          const left = (unprovenBySource.get(source) ?? 1) - 1
          if (left > 0) unprovenBySource.set(source, left)
          else unprovenBySource.delete(source)
        }
      }
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

/** How long a turned-away peer has to hang up after its answer. */
const ANSWER_LINGER_MS = 2_000

function peerHangsUp(channel: SecureChannel): Promise<void> {
  return new Promise((resolve) => {
    if (channel.closed) return resolve()
    const timer = setTimeout(resolve, ANSWER_LINGER_MS)
    channel.onClose(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Answers an unpaired (never paired or removed) device's hello with a
 * refusal, so its client stops retrying and says why, and closes. It names no
 * version: an unpaired peer learns nothing about the runtime.
 */
async function refuse(channel: SecureChannel): Promise<void> {
  // The refusal answers the hello, so the client is listening when it lands.
  if (await nextFrame(channel, OPENING_TIMEOUT_MS) instanceof Uint8Array) secureFramePort(channel).send({
    kind: 'msg',
    msg: {
      t: 'hello',
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
