import type { AgentProviderId, AgentProviderStatus } from '../../shared/t3Agent'

export const PROVIDER_STATUS_CACHE: Record<AgentProviderId, string> = {
  codex: 'codex.json',
  claude: 'claudeAgent.json',
  cursor: 'cursor.json',
  grok: 'grok.json',
  opencode: 'opencode.json',
}

export function providerStatusFromSnapshot(
  providerId: AgentProviderId,
  snapshot: Record<string, unknown> | null,
): AgentProviderStatus {
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
  const latestVersion = advisory?.status === 'behind_latest'
    && typeof advisory.latestVersion === 'string'
    ? advisory.latestVersion
    : undefined
  const updateMessage = typeof advisory?.message === 'string' ? advisory.message : undefined
  let state: AgentProviderStatus['state'] = 'unknown'
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
