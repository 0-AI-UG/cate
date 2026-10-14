// Why a network dial failed, in words for people: one short sentence from what
// Cate Connect answered, pointing at what to change. Shown as it is by a failed
// join and by the connection status of a paired workspace.

import { CateConnectError, type CateConnectErrorCode } from '../../connect/contract'
import { SameNetworkUnreachableError, type SameNetworkFailure } from './sameNetwork'

export interface NetworkFailure {
  sameNetwork: SameNetworkFailure
  /** What Cate Connect answered; absent when it was not tried (a pairing code
   *  for the same network only). `failed`: anything else went wrong. */
  connect?: CateConnectErrorCode | 'failed'
}

export class NetworkUnreachableError extends Error {
  constructor(readonly failure: NetworkFailure) {
    super(networkFailureMessage(failure))
  }
}

export function sameNetworkFailureOf(error: unknown): SameNetworkFailure {
  return error instanceof SameNetworkUnreachableError ? error.reason : 'noAnswer'
}

export function connectFailureOf(error: unknown): NonNullable<NetworkFailure['connect']> {
  return error instanceof CateConnectError ? error.code : 'failed'
}

export function networkFailureMessage(failure: NetworkFailure): string {
  switch (failure.connect) {
    case undefined:
      return 'Not found on this network. To reach it from elsewhere, share it "Anywhere" on its machine.'
    case 'offline':
      return 'Its machine is asleep or off, or shares on its own network only.'
    case 'unreachable':
      return 'Cate Connect is unreachable. Check your internet connection.'
    case 'no-path':
      return 'No way through. A firewall may be blocking it.'
    default:
      return 'Cate Connect could not open a connection.'
  }
}
