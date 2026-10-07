// The provider profile: the provider-owned part of T3's settings, published
// from the instance where the user edited it to `<t3>/provider-profile.json`
// and applied to every other checkout's instance of the workspace.

import { T3_PROVIDERS } from './providers'

const PROVIDER_SETTING_KEYS = [
  'providers',
  'providerInstances',
  'usageLimitSources',
  'enableProviderUpdateChecks',
  'backgroundActivity',
  'textGenerationModelSelection',
  'sourceControlWriterModelSelection',
] as const

/** Fields the provider settings page may save through `t3.providerSettings`. */
export const PROVIDER_SETTINGS_PATCH_KEYS: ReadonlySet<string> = new Set([
  'providers',
  'providerInstances',
  'enableProviderUpdateChecks',
  'sidebarAutoSettleAfterDays',
  'sidebarAutoSettleOnMerge',
  'textGenerationModelSelection',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Gives every provider an explicit `enabled`, off for the opt-in ones.
 *  Explicit user choices stay. */
export function applyCateProviderDefaults(settings: Record<string, unknown>): Record<string, unknown> {
  const current = isRecord(settings.providers) ? settings.providers : {}
  let changed = !isRecord(settings.providers)
  const providers = { ...current }
  for (const { driverId, optIn } of T3_PROVIDERS) {
    const entry = providers[driverId]
    if (isRecord(entry) && typeof entry.enabled === 'boolean') continue
    providers[driverId] = { ...(isRecord(entry) ? entry : {}), enabled: !optIn }
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

/** T3 settings with the profile's provider keys, and the settings Cate always
 *  enforces: threads run in the checkout, T3's own browser is off. */
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
  return enforceCateSettings(next)
}

export function enforceCateSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return { ...settings, defaultThreadEnvMode: 'local', enableAgentBrowserAccess: false }
}

export function isProviderSecretFile(name: string): boolean {
  return (name.startsWith('provider-env-') || name.startsWith('usage-limit-source-'))
    && name.endsWith('.bin')
}

/** T3's decoding defaults (t3@0.0.39 ServerSettings) of the preferences the
 *  providers page shows, for settings read from disk. */
const T3_PREFERENCE_DEFAULTS: Record<string, unknown> = {
  enableProviderUpdateChecks: true,
  sidebarAutoSettleOnMerge: true,
  sidebarAutoSettleAfterDays: 3,
}

/** T3 settings from its settings file as `server.getConfig` gives them to a
 *  client: the shown preferences' defaults filled in, and secret environment
 *  values blanked (T3's redactProviderEnvironmentVariable). */
export function t3SettingsForClient(settings: Record<string, unknown>): Record<string, unknown> {
  const instances = isRecord(settings.providerInstances) ? settings.providerInstances : null
  return {
    ...T3_PREFERENCE_DEFAULTS,
    ...settings,
    ...(instances
      ? {
          providerInstances: Object.fromEntries(Object.entries(instances).map(([id, instance]) => {
            if (!isRecord(instance) || !Array.isArray(instance.environment)) return [id, instance]
            return [id, { ...instance, environment: instance.environment.map((variable: unknown) => {
              if (!isRecord(variable) || variable.sensitive !== true) return variable
              const hasValue = typeof variable.value === 'string' && variable.value.length > 0
              return { ...variable, value: '', ...(hasValue || variable.valueRedacted ? { valueRedacted: true } : {}) }
            }) }]
          })),
        }
      : {}),
  }
}
