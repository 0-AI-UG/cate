// A WebRTC data channel as a message port, and the offer/answer exchange that
// opens one. The peer connection comes from a factory: `node-datachannel` in
// the runtime and on desktop, the platform's own on mobile or in a browser.
// Signaling goes through whatever carries it (Cate Connect). Pure.

import type { MessagePortLike } from '../../security/contract'
import { createPortCore } from './portCore'
import { toBytes } from './webSocket'

export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface SessionDescription {
  type: 'offer' | 'answer'
  sdp: string
}

export interface IceCandidate {
  candidate: string
  sdpMid: string | null
}

export type SignalMessage =
  | { kind: 'description'; description: SessionDescription }
  | { kind: 'candidate'; candidate: IceCandidate }

/** Where signals go to and come from the other side. */
export interface SignalingPort {
  send(signal: SignalMessage): void
  onSignal(listener: (signal: SignalMessage) => void): () => void
}

export interface DataChannelLike {
  binaryType: string
  readonly readyState: string
  send(data: Uint8Array): void
  close(): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
}

/** The part of `RTCPeerConnection` used here. */
export interface PeerConnectionLike {
  readonly connectionState: string
  readonly localDescription: { type: string; sdp: string } | null
  createDataChannel(label: string, init?: { ordered?: boolean }): DataChannelLike
  createOffer(): Promise<{ type: string; sdp?: string }>
  createAnswer(): Promise<{ type: string; sdp?: string }>
  setLocalDescription(description: { type: string; sdp?: string }): Promise<void>
  setRemoteDescription(description: SessionDescription): Promise<void>
  addIceCandidate(candidate: IceCandidate): Promise<void>
  onicecandidate: ((event: { candidate: { candidate: string; sdpMid?: string | null } | null }) => void) | null
  ondatachannel: ((event: { channel: DataChannelLike }) => void) | null
  onconnectionstatechange: ((event: unknown) => void) | null
  close(): void
}

export type PeerConnectionFactory = (config: { iceServers: IceServer[] }) => PeerConnectionLike

export const DATA_CHANNEL_LABEL = 'cate'
const DEFAULT_TIMEOUT_MS = 20_000
const CLOSE_GRACE_MS = 2_000

export class DataChannelError extends Error {
  constructor(message: string, readonly reason: 'failed' | 'timeout' | 'closed' | 'signaling') {
    super(message)
  }
}

/** Adapts an open data channel; closing either closes the peer connection. */
export function dataChannelPort(channel: DataChannelLike, peer?: PeerConnectionLike): MessagePortLike {
  channel.binaryType = 'arraybuffer'
  const core = createPortCore()
  let peerTimer: ReturnType<typeof setTimeout> | null = null
  const closePeer = () => {
    if (peerTimer) clearTimeout(peerTimer)
    try { peer?.close() } catch { /* already closed */ }
  }
  // Closing the channel first lets queued messages (a refusal just before
  // hanging up) go out; the peer connection follows once the channel is
  // closed, or after a grace period.
  const teardown = () => {
    try { channel.close() } catch { /* already closed */ }
    if (peer && !peerTimer) peerTimer = setTimeout(closePeer, CLOSE_GRACE_MS)
  }
  channel.onmessage = (event) => {
    const bytes = toBytes(event.data)
    if (bytes) return core.deliver(bytes)
    teardown()
    core.finish(new Error('unexpected text message'))
  }
  channel.onclose = () => {
    closePeer()
    core.finish()
  }
  channel.onerror = (event) => {
    const error = (event as { error?: { message?: string } } | undefined)?.error
    teardown()
    core.finish(new Error(error?.message ?? 'data channel error'))
  }
  if (peer) {
    const previous = peer.onconnectionstatechange
    peer.onconnectionstatechange = (event) => {
      previous?.(event)
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        closePeer()
        core.finish(new Error(`peer connection ${peer.connectionState}`))
      }
    }
  }
  return core.port((message) => channel.send(message), teardown)
}

export interface DataChannelOptions {
  createPeer: PeerConnectionFactory
  iceServers: IceServer[]
  signaling: SignalingPort
  timeoutMs?: number
}

/** The connecting side: creates the channel and sends the offer. */
export function offerDataChannel(options: DataChannelOptions): Promise<MessagePortLike> {
  return negotiate(options, async (peer, settle) => {
    const channel = peer.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true })
    channel.onopen = () => settle(channel)
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    const local = peer.localDescription ?? offer
    options.signaling.send({ kind: 'description', description: { type: 'offer', sdp: local.sdp ?? '' } })
  })
}

/** The accepting side: waits for the offer and the channel the other side opens. */
export function answerDataChannel(options: DataChannelOptions): Promise<MessagePortLike> {
  return negotiate(options, (peer, settle) => {
    peer.ondatachannel = (event) => {
      const channel = event.channel
      if (channel.readyState === 'open') settle(channel)
      else channel.onopen = () => settle(channel)
    }
  }, async (peer, description) => {
    if (description.type !== 'offer') throw new DataChannelError('expected an offer', 'signaling')
    const answer = await peer.createAnswer()
    await peer.setLocalDescription(answer)
    const local = peer.localDescription ?? answer
    options.signaling.send({ kind: 'description', description: { type: 'answer', sdp: local.sdp ?? '' } })
  })
}

function negotiate(
  options: DataChannelOptions,
  start: (peer: PeerConnectionLike, settle: (channel: DataChannelLike) => void) => void | Promise<void>,
  onRemote?: (peer: PeerConnectionLike, description: SessionDescription) => Promise<void>,
): Promise<MessagePortLike> {
  return new Promise((resolve, reject) => {
    const peer = options.createPeer({ iceServers: options.iceServers })
    let settled = false
    let remoteSet = false
    const pending: IceCandidate[] = []

    const finish = (result: DataChannelLike | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      offSignal()
      if (result instanceof Error) {
        try { peer.close() } catch { /* already closed */ }
        reject(result)
      } else {
        resolve(dataChannelPort(result, peer))
      }
    }
    const fail = (error: unknown) => finish(
      error instanceof DataChannelError ? error : new DataChannelError(error instanceof Error ? error.message : String(error), 'signaling'),
    )
    const timer = setTimeout(
      () => finish(new DataChannelError('no direct connection within the time limit', 'timeout')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )

    peer.onicecandidate = (event) => {
      if (settled || !event.candidate || !event.candidate.candidate) return
      options.signaling.send({
        kind: 'candidate',
        candidate: { candidate: event.candidate.candidate, sdpMid: event.candidate.sdpMid ?? null },
      })
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') finish(new DataChannelError('direct connection failed', 'failed'))
      else if (peer.connectionState === 'closed') finish(new DataChannelError('peer connection closed', 'closed'))
    }

    const offSignal = options.signaling.onSignal((signal) => {
      if (settled) return
      void (async () => {
        if (signal.kind === 'candidate') {
          if (remoteSet) await peer.addIceCandidate(signal.candidate)
          else pending.push(signal.candidate)
          return
        }
        await peer.setRemoteDescription(signal.description)
        remoteSet = true
        await onRemote?.(peer, signal.description)
        for (const candidate of pending.splice(0)) await peer.addIceCandidate(candidate)
      })().catch(fail)
    })

    Promise.resolve()
      .then(() => start(peer, (channel) => finish(channel)))
      .catch(fail)
  })
}
