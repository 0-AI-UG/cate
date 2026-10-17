// Client side of the same-network transport. Portable: the WebSocket comes
// from the shell (a web view's own, or `ws` under Node) and so does mDNS.

import type { MessagePortLike } from '../../security/contract'
import { openWebSocket, sameNetworkUrl, type WebSocketFactory } from '../contract'

export interface SameNetworkDialOptions<T = MessagePortLike> {
  runtimeId: string
  /** Addresses from the pairing payload or remembered from the last connection. */
  addresses?: readonly string[]
  /** mDNS lookup by runtimeId, when the platform has it. */
  discover?: (runtimeId: string, signal: AbortSignal) => Promise<string[]>
  webSocket: WebSocketFactory
  timeoutMs?: number
  /** Checks an opened port before it wins (the security handshake): one that
   *  fails is closed and the other addresses still count. `release` frees a
   *  checked result that came in after another won. */
  verify?: { check(port: MessagePortLike): Promise<T>; release(value: T): void }
}

/** Why the same network did not reach the runtime: no address to dial (none
 *  known, none discovered), addresses that did not answer, or only answers
 *  that failed the check (another machine or runtime at a known address). */
export type SameNetworkFailure = 'notFound' | 'noAnswer' | 'otherRuntime'

export class SameNetworkUnreachableError extends Error {
  constructor(readonly reason: SameNetworkFailure, message: string) {
    super(message)
  }
}

/**
 * Dials every known address and every discovered one at once; the first to
 * open (and pass `verify`, when given) wins and the rest are closed.
 */
export function dialSameNetwork(options: SameNetworkDialOptions): Promise<MessagePortLike>
export function dialSameNetwork<T>(options: SameNetworkDialOptions<T> & { verify: NonNullable<SameNetworkDialOptions<T>['verify']> }): Promise<T>
export function dialSameNetwork<T>(options: SameNetworkDialOptions<T>): Promise<T | MessagePortLike> {
  const timeoutMs = options.timeoutMs ?? 8_000
  const verify = options.verify
  return new Promise((resolve, reject) => {
    const abort = new AbortController()
    const tried = new Set<string>()
    const errors: string[] = []
    let dialed = 0
    let opened = 0
    let inFlight = 0
    let discovering = false
    let settled = false

    const late = (value: T | MessagePortLike) => {
      if (verify) verify.release(value as T)
      else (value as MessagePortLike).close()
    }
    const settle = (value: T | MessagePortLike | Error) => {
      if (settled) {
        if (!(value instanceof Error)) late(value)
        return
      }
      settled = true
      clearTimeout(timer)
      abort.abort()
      if (value instanceof Error) reject(value)
      else resolve(value)
    }
    const reason = (): SameNetworkFailure => (opened > 0 ? 'otherRuntime' : dialed > 0 ? 'noAnswer' : 'notFound')
    const giveUpIfDone = () => {
      if (inFlight === 0 && !discovering) {
        settle(new SameNetworkUnreachableError(
          reason(),
          errors.length > 0
            ? `could not reach the workspace on this network (${errors.join('; ')})`
            : 'could not find the workspace on this network',
        ))
      }
    }
    const failed = (error: Error) => {
      inFlight--
      errors.push(error.message)
      giveUpIfDone()
    }
    const dial = (address: string) => {
      if (settled || tried.has(address)) return
      tried.add(address)
      const url = sameNetworkUrl(address, options.runtimeId)
      if (!url) return
      dialed++
      inFlight++
      openWebSocket(options.webSocket, url, timeoutMs).then(
        (port) => {
          opened++
          if (!verify) return settle(port)
          if (settled) return port.close()
          verify.check(port).then(
            (value) => settle(value),
            (error: Error) => {
              port.close()
              failed(error)
            },
          )
        },
        failed,
      )
    }
    const timer = setTimeout(() => settle(new SameNetworkUnreachableError(reason(), 'timed out looking for the workspace on this network')), timeoutMs)

    for (const address of options.addresses ?? []) dial(address)
    if (options.discover) {
      discovering = true
      options.discover(options.runtimeId, abort.signal).then(
        (found) => {
          discovering = false
          for (const address of found) dial(address)
          giveUpIfDone()
        },
        () => {
          discovering = false
          giveUpIfDone()
        },
      )
    } else {
      giveUpIfDone()
    }
  })
}
