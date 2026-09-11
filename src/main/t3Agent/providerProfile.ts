import { T3_AGENTS } from '../../shared/agents'

const PROVIDER_SETTING_KEYS = [
  'cateProviderDefaultsVersion',
  'providers',
  'providerInstances',
  'usageLimitSources',
  'enableProviderUpdateChecks',
  'backgroundActivity',
  'textGenerationModelSelection',
  'sourceControlWriterModelSelection',
] as const

const CATE_DEFAULT_PROVIDER_KEYS = T3_AGENTS.map((agent) => agent.t3.driverId)
const CATE_PROVIDER_DEFAULTS_VERSION = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Grok and OpenCode are opt-in because probing them can launch CLI processes.
 * Keep explicit user choices intact once a provider has been configured. */
export function applyCateProviderDefaults(settings: Record<string, unknown>): Record<string, unknown> {
  const currentProviders = isRecord(settings.providers) ? settings.providers : {}
  const needsOpenCodeMigration = settings.cateProviderDefaultsVersion !== CATE_PROVIDER_DEFAULTS_VERSION
  let changed = !isRecord(settings.providers) || needsOpenCodeMigration
  const providers = { ...currentProviders }

  for (const key of CATE_DEFAULT_PROVIDER_KEYS) {
    const current = providers[key]
    if (
      key === 'opencode'
      && needsOpenCodeMigration
      && isRecord(current)
      && current.enabled === true
      && Object.keys(current).every((setting) => setting === 'enabled')
    ) {
      providers[key] = { enabled: false }
      continue
    }
    if (isRecord(current) && typeof current.enabled === 'boolean') continue
    providers[key] = { ...(isRecord(current) ? current : {}), enabled: key !== 'grok' && key !== 'opencode' }
    changed = true
  }

  return changed
    ? { ...settings, cateProviderDefaultsVersion: CATE_PROVIDER_DEFAULTS_VERSION, providers }
    : settings
}

export function extractProviderProfile(settings: Record<string, unknown>): Record<string, unknown> {
  const profile: Record<string, unknown> = {}
  for (const key of PROVIDER_SETTING_KEYS) {
    if (Object.hasOwn(settings, key)) profile[key] = settings[key]
  }
  return profile
}

export function applyProviderProfile(
  settings: Record<string, unknown>,
  profile: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings }
  for (const key of PROVIDER_SETTING_KEYS) {
    delete next[key]
    if (Object.hasOwn(profile, key)) next[key] = profile[key]
  }
  delete next.providerHealthRefreshInterval
  delete next.enableLegacyTokenStreaming
  next.defaultThreadEnvMode = 'local'
  next.enableAgentBrowserAccess = false
  return next
}

export function isProviderSecretFile(name: string): boolean {
  return (name.startsWith('provider-env-') || name.startsWith('usage-limit-source-'))
    && name.endsWith('.bin')
}
