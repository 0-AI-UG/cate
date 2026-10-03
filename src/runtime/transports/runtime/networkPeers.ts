// Every network connection, whatever carried it, goes through here: the
// Noise handshake and the pairing policy (runtime/security), then the rpc
// frames. The `hello` must name the device key the handshake proved, a
// device is marked seen when it connects, and revoking it drops its
// connections (architecture 7.6).

import { RpcError, toWireError, type Frame, type FramePort, type HelloMessage } from '@kernel/rpc/contract'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import { bytesToHex, fingerprint, type KeyPair, type MessagePortLike, type SecureChannel } from '../../security/contract'
import { acceptPeer, type PeerPolicy } from '../../security/runtime'
import { secureFramePort } from '../contract'

export interface NetworkPairing extends PeerPolicy {
  markSeen(publicKey: Uint8Array): void
  /** Called with the hex public key of a removed device. */
  onRevoked(listener: (publicKey: string) => void): () => void
}

export interface NetworkPeersOptions {
  rpc: RpcServer
  runtimeKeys: KeyPair
  pairing: NetworkPairing
  log?: Logger
  handshakeTimeoutMs?: number
}

export interface NetworkPeers {
  /** Secures and serves one incoming connection. Resolves once it is served
   *  or refused; a refusal closes the port. */
  accept(port: MessagePortLike): Promise<void>
  /** Live connections by device (hex public key). */
  connected(): string[]
  /** Drops every network connection (network access turned off). */
  closeAll(): void
  dispose(): void
}

export function createNetworkPeers(options: NetworkPeersOptions): NetworkPeers {
  const live = new Map<SecureChannel, string>()

  const offRevoked = options.pairing.onRevoked((publicKey) => {
    for (const [channel, key] of live) {
      if (key === publicKey) channel.close(new Error('device removed'))
    }
  })

  return {
    async accept(port) {
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
      }
      const key = bytesToHex(channel.remoteStatic)
      // A revoke can land while the handshake runs.
      if (!(await options.pairing.isPaired(channel.remoteStatic))) {
        refuse(channel, options.rpc)
        channel.close(new Error('device removed'))
        return
      }
      live.set(channel, key)
      channel.onClose(() => live.delete(channel))
      options.pairing.markSeen(channel.remoteStatic)
      options.rpc.serve(checkedHello(secureFramePort(channel), fingerprint(channel.remoteStatic), options.rpc))
    },
    connected: () => [...live.values()],
    closeAll() {
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
 * refusal, so its client stops retrying and says why.
 */
function refuse(channel: SecureChannel, rpc: RpcServer): void {
  secureFramePort(channel).send({
    kind: 'msg',
    msg: {
      t: 'hello',
      protocol: rpc.protocol,
      version: rpc.opts.version,
      error: toWireError(new RpcError('rejected', 'This device is not paired with this workspace')),
    },
  })
}

/**
 * Refuses a `hello` that is not a client naming the key this connection
 * proved. A caller token has no business on a network connection.
 */
function checkedHello(port: FramePort, keyFingerprint: string, rpc: RpcServer): FramePort {
  let checked = false
  return {
    send: (frame) => port.send(frame),
    close: (reason) => port.close(reason),
    onClose: (listener) => port.onClose(listener),
    onFrame(listener) {
      port.onFrame((frame: Frame) => {
        if (!checked && frame.kind === 'msg' && frame.msg.t === 'hello') {
          const hello = frame.msg as HelloMessage
          if (hello.caller || hello.client?.device?.keyFingerprint !== keyFingerprint) {
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
