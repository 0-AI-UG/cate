import { T3_PROVIDERS, type T3ProviderId } from './providers'
import type { T3Model, T3ProviderModels, T3ProviderStatus } from './types'

/** Status from T3's cached provider probe (`<instance>/caches/<file>`). */
export function providerStatusFromSnapshot(
  providerId: T3ProviderId,
  snapshot: Record<string, unknown> | null,
): T3ProviderStatus {
  if (!snapshot) return { providerId, state: 'unknown' }
  const auth = snapshot.auth && typeof snapshot.auth === 'object'
    ? snapshot.auth as Record<string, unknown>
    : {}
  const label = typeof auth.label === 'string' ? auth.label : undefined
  const message = typeof snapshot.message === 'string' ? snapshot.message : undefined
  const version = typeof snapshot.version === 'string' ? snapshot.version : undefined
  const advisory = snapshot.versionAdvisory && typeof snapshot.versionAdvisory === 'object'
    ? snapshot.versionAdvisory as Record<string, unknown>
    : null
  const latestVersion = advisory?.status === 'behind_latest' && typeof advisory.latestVersion === 'string'
    ? advisory.latestVersion
    : undefined
  const updateMessage = typeof advisory?.message === 'string' ? advisory.message : undefined
  let state: T3ProviderStatus['state'] = 'unknown'
  if (snapshot.enabled === false) state = 'disabled'
  else if (snapshot.installed === false) state = 'unavailable'
  else if (auth.status === 'authenticated') state = 'authenticated'
  else if (auth.status === 'unauthenticated') state = 'unauthenticated'
  else if (snapshot.status === 'ready') state = 'authenticated'
  return {
    providerId,
    state,
    ...(label ? { label } : {}),
    ...(message ? { message } : {}),
    ...(version ? { version } : {}),
    ...(latestVersion
      ? {
          update: {
            latestVersion,
            canUpdate: advisory?.canUpdate === true,
            ...(updateMessage ? { message: updateMessage } : {}),
          },
        }
      : {}),
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** The provider instances in T3's server config (`server.getConfig`) that Cate
 *  knows, with the models each offers, in registry order. */
export function t3ProviderModelsFromConfig(providers: unknown): T3ProviderModels[] {
  const list = Array.isArray(providers) ? providers.map(record).filter((entry) => entry !== null) : []
  return T3_PROVIDERS.flatMap(({ providerId, driverId }) => list
    .filter((entry) => entry.driver === driverId && typeof entry.instanceId === 'string')
    .map((entry): T3ProviderModels => {
      const status = providerStatusFromSnapshot(providerId, entry)
      const models = (Array.isArray(entry.models) ? entry.models : []).flatMap((raw): T3Model[] => {
        const model = record(raw)
        if (typeof model?.slug !== 'string' || typeof model.name !== 'string' || model.isLegacy === true) return []
        return [{ slug: model.slug, name: model.name, isDefault: model.isDefault === true }]
      })
      return {
        providerId,
        instanceId: entry.instanceId as string,
        label: typeof entry.displayName === 'string' ? entry.displayName : providerId,
        ready: status.state === 'authenticated' && models.length > 0,
        ...(status.message ? { message: status.message } : {}),
        models,
      }
    }))
}
