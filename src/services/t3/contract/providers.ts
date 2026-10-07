// The providers T3 runs: the agents registry's `runners.t3` entries (provider
// and T3 driver id), plus what T3 itself needs to know of each.

import { AGENTS, type T3ProviderId } from '@services/agents/contract/registry'

export type { T3ProviderId }

export interface T3ProviderDef {
  providerId: T3ProviderId
  /** Key under T3 settings' `providers`. */
  driverId: string
  /** Probing it launches a CLI process, so Cate leaves it off until chosen. */
  optIn: boolean
}

const OPT_IN: ReadonlySet<T3ProviderId> = new Set(['grok', 'opencode'])

export const T3_PROVIDERS: readonly T3ProviderDef[] = AGENTS.flatMap((agent) => {
  const t3 = agent.runners.t3
  return t3 ? [{ providerId: t3.providerId, driverId: t3.driverId, optIn: OPT_IN.has(t3.providerId) }] : []
})

export function t3Provider(providerId: T3ProviderId): T3ProviderDef {
  const def = T3_PROVIDERS.find((provider) => provider.providerId === providerId)
  if (!def) throw new Error(`Unknown agent provider ${providerId}`)
  return def
}
