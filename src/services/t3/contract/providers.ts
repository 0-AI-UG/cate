// The providers T3 runs, and what T3 needs to know of each. The agents
// service maps its agents onto these (an agent's `runners.t3`); t3 knows
// nothing of agents.

export type T3ProviderId = 'codex' | 'claude' | 'cursor' | 'grok' | 'opencode'
export type T3DriverId = 'codex' | 'claudeAgent' | 'cursor' | 'grok' | 'opencode'

export interface T3ProviderDef {
  providerId: T3ProviderId
  /** Key under T3 settings' `providers`. */
  driverId: T3DriverId
  /** Probing it launches a CLI process, so Cate leaves it off until chosen. */
  optIn: boolean
}

export const T3_PROVIDERS: readonly T3ProviderDef[] = [
  { providerId: 'claude', driverId: 'claudeAgent', optIn: false },
  { providerId: 'codex', driverId: 'codex', optIn: false },
  { providerId: 'cursor', driverId: 'cursor', optIn: false },
  { providerId: 'grok', driverId: 'grok', optIn: true },
  { providerId: 'opencode', driverId: 'opencode', optIn: true },
]

export function t3Provider(providerId: T3ProviderId): T3ProviderDef {
  const def = T3_PROVIDERS.find((provider) => provider.providerId === providerId)
  if (!def) throw new Error(`Unknown agent provider ${providerId}`)
  return def
}

/** The provider T3 names. T3 has used both its public provider id and its
 *  internal driver id at integration boundaries, so accept either. */
export function t3ProviderNamed(name: string): T3ProviderDef | undefined {
  return T3_PROVIDERS.find((provider) => provider.providerId === name || provider.driverId === name)
}
