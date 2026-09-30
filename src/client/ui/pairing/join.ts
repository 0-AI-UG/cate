// Joining a workspace on another device (7.7, 13.2): read the scanned link or
// typed code, let the shell reach the runtime and pair where the device key
// lives (the proofs bind the one-time secret to that encrypted session), then
// record the workspace. Afterwards the device reconnects by key.

import {
  decodePairingUri,
  parsePairingCode,
  PairingFormatError,
} from '@runtime/pairing/contract'
import { PairingError } from '@runtime/pairing/client'
import type { NetworkEndpoint, ShellTransports } from '@client/connections'
import type { PairedWorkspace, WorkspaceList } from '@client/workspaces'

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
    const endpoints: NetworkEndpoint[] = []
    for (const address of payload.addresses) {
      const colon = address.lastIndexOf(':')
      const port = Number(address.slice(colon + 1))
      if (colon > 0 && Number.isInteger(port) && port > 0) endpoints.push({ kind: 'lan', address: address.slice(0, colon), port })
    }
    if (payload.mode === 'cateConnect') endpoints.push({ kind: 'connect' })
    return { runtimeId: payload.runtimeId, secret: payload.secret, fingerprint: payload.fingerprint, endpoints }
  }
  const code = parsePairingCode(input)
  return { runtimeId: code.runtimeId, secret: code.secret, endpoints: [] }
}

/** A message for a failed join. */
export function joinErrorMessage(err: unknown): string {
  if (err instanceof PairingFormatError) return 'That is not a Cate pairing code.'
  if (err instanceof PairingError) {
    switch (err.reason) {
      case 'fingerprint-mismatch': return 'The workspace that answered is not the one in the code.'
      case 'timeout': return 'The workspace did not answer in time.'
      case 'closed': return 'The workspace closed the connection.'
      case 'bad-runtime-proof': return 'The workspace could not prove it knows the code.'
      default: return 'The code was refused. Codes work once and expire after 10 minutes; ask for a new one.'
    }
  }
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
    name: `Workspace ${paired.runtimeId.slice(0, 4).toUpperCase()}`,
    endpoints: paired.endpoints.length ? paired.endpoints : target.endpoints,
    publicKey: paired.publicKey,
  })
}
