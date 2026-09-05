const PROVIDER_SETTING_KEYS = [
  'providers',
  'providerInstances',
  'usageLimitSources',
  'enableProviderUpdateChecks',
  'providerHealthRefreshInterval',
  'backgroundActivity',
  'textGenerationModelSelection',
  'sourceControlWriterModelSelection',
] as const

const CATE_DEFAULT_PROVIDER_KEYS = [
  'codex',
  'claudeAgent',
  'cursor',
  'grok',
  'opencode',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Cate exposes every bundled provider in the model picker by default. Keep
 * explicit user choices intact once a provider has been configured. */
export function applyCateProviderDefaults(settings: Record<string, unknown>): Record<string, unknown> {
  const currentProviders = isRecord(settings.providers) ? settings.providers : {}
  let changed = !isRecord(settings.providers)
  const providers = { ...currentProviders }

  for (const key of CATE_DEFAULT_PROVIDER_KEYS) {
    const current = providers[key]
    if (isRecord(current) && typeof current.enabled === 'boolean') continue
    providers[key] = { ...(isRecord(current) ? current : {}), enabled: true }
    changed = true
  }

  return changed ? { ...settings, providers } : settings
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
  next.defaultThreadEnvMode = 'local'
  next.enableAgentBrowserAccess = false
  return next
}

export function isProviderSecretFile(name: string): boolean {
  return (name.startsWith('provider-env-') || name.startsWith('usage-limit-source-'))
    && name.endsWith('.bin')
}
