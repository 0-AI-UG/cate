// Joining a workspace on another device (7.7, 13.2): read the scanned link or
// typed code, let the shell reach the runtime and pair where the device key
// lives (the proofs bind the one-time secret to that encrypted session), then
// record the workspace. Afterwards the device reconnects by key.

import {
  decodePairingUri,
  parsePairingCode,
  PairingFormatError,
} from '@runtime/pairing/contract'
import { PairingError, pairingErrorMessage } from '@runtime/pairing/client'
import type { ShellTransports } from '@client/connections'
import { pairingEndpoints, type NetworkEndpoint } from '@runtime/transports/contract'
import type { PairedWorkspace, WorkspaceList } from './workspaceList'
import { placeholderName } from './naming'

export interface PairingTarget {
  runtimeId: string
  secret: Uint8Array
  /** Only from a scanned link. */
  fingerprint?: string
  endpoints: NetworkEndpoint[]
}

/** Parses a `cate://pair?...` link or a typed pairing code. Throws
 *  PairingFormatError with a message to show. */
export function parsePairingInput(text: string): PairingTarget {
  const input = text.trim()
  if (input.startsWith('cate://')) {
    const payload = decodePairingUri(input)
    return { runtimeId: payload.runtimeId, secret: payload.secret, fingerprint: payload.fingerprint, endpoints: pairingEndpoints(payload.addresses, payload.mode) }
  }
  const code = parsePairingCode(input)
  return { runtimeId: code.runtimeId, secret: code.secret, endpoints: [] }
}

/** A message for a failed join. */
export function joinErrorMessage(err: unknown): string {
  if (err instanceof PairingFormatError) return 'That is not a Cate pairing code.'
  if (err instanceof PairingError) return pairingErrorMessage(err)
  // A shell that pairs in another process already sent the words.
  return err instanceof Error ? err.message : String(err)
}

export interface JoinDeps {
  pair: NonNullable<ShellTransports['pair']>
  workspaces: WorkspaceList
}

/** Pairs with the runtime behind `input` and adds it to the workspace list. */
export async function joinWorkspace(input: string, deps: JoinDeps): Promise<PairedWorkspace> {
  // A malformed code fails here, with a readable message, before any dial.
  const target = parsePairingInput(input)
  const paired = await deps.pair(input.trim())
  if (paired.runtimeId !== target.runtimeId) throw new PairingError('a different workspace answered', 'fingerprint-mismatch')
  return deps.workspaces.addPaired({
    runtimeId: paired.runtimeId,
    name: placeholderName(paired.runtimeId),
    endpoints: paired.endpoints.length ? paired.endpoints : target.endpoints,
    publicKey: paired.publicKey,
  })
}
