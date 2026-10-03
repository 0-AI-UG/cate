import type { T3ProviderId } from './providers'
import type { T3ProviderStatus } from './types'

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
