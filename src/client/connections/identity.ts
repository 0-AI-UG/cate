// Who this client is to every runtime: a random clientId picked at start and
// kept across reconnects, its op counter, the device, and the features the
// shell declared (12.2). Client code asks `clientHas`, never which shell or
// platform it is.

import { knownFeatures, type ClientFeature, type DeviceInfo } from '@kernel/rpc/contract'

export interface ClientIdentity {
  readonly clientId: string
  readonly device: DeviceInfo
  readonly features: ReadonlySet<ClientFeature>
  /** The next op counter of this clientId, shared by every connection and
   *  document mirror (the runtime remembers the highest it saw). */
  nextCounter(): number
}

export function createClientIdentity(opts: {
  device: DeviceInfo
  features: readonly ClientFeature[]
  clientId?: string
}): ClientIdentity {
  let counter = 0
  return Object.freeze({
    clientId: opts.clientId ?? globalThis.crypto.randomUUID(),
    device: { ...opts.device },
    features: new Set(knownFeatures(opts.features)),
    nextCounter: () => ++counter,
  })
}

let installed: ClientIdentity | null = null

/** The shell installs its identity once at start. */
export function installClientIdentity(identity: ClientIdentity | null): void {
  installed = identity
}

export function clientIdentity(): ClientIdentity {
  if (!installed) throw new Error('No client identity installed')
  return installed
}

export function clientHas(feature: ClientFeature): boolean {
  return installed?.features.has(feature) ?? false
}
