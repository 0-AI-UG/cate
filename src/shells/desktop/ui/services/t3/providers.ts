// The providers T3 runs as the settings pages name them.

import { T3_PROVIDERS, type T3ProviderId } from '@services/t3/contract'
import { t3ProductCopy } from '@services/t3/client'

export interface T3ProviderLogin {
  id: T3ProviderId
  /** Key under T3 settings' `providers`. */
  driverId: string
  name: string
  description: string
}

const NAMES: Record<T3ProviderId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  grok: 'Grok',
  opencode: 'OpenCode',
}

const DESCRIPTIONS: Record<T3ProviderId, string> = {
  codex: 'ChatGPT account or OpenAI API key',
  claude: 'Claude account or Anthropic API key',
  cursor: 'Cursor account or API key',
  grok: 'xAI account',
  opencode: 'Choose and authenticate an OpenCode model provider',
}

export const T3_PROVIDER_LOGINS: readonly T3ProviderLogin[] = T3_PROVIDERS.map((provider) => ({
  id: provider.providerId,
  driverId: provider.driverId,
  name: NAMES[provider.providerId],
  description: DESCRIPTIONS[provider.providerId],
}))

export function providerUpdateFeedback(provider?: {
  version?: string
  versionAdvisory?: { updateCommand?: string | null }
  updateState?: { status?: string; message?: string | null }
}): { error: boolean; message: string } {
  const state = provider?.updateState
  if (state?.status === 'unchanged') {
    const brew = /^brew\s+upgrade\b/.test(provider?.versionAdvisory?.updateCommand ?? '')
    return {
      error: true,
      message: brew
        ? `Homebrew finished, but the active provider is still ${provider?.version ?? 'on the previous version'}. The announced release may not be available in Homebrew yet. Check the update output below; Cate will keep using the installed version.`
        : 'The update command finished, but the active provider version did not reach the announced release. Check the output and binary path below for a different installation or an unavailable package release.',
    }
  }
  return {
    error: state?.status === 'failed' || !state || state.status !== 'succeeded',
    message: t3ProductCopy(state?.message || 'The provider update could not be verified. Refresh providers to check its status.'),
  }
}
