import { agentProductCopy } from '../../shared/agentProductCopy'
export { agentProductCopy } from '../../shared/agentProductCopy'

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
    message: agentProductCopy(state?.message || 'The provider update could not be verified. Refresh providers to check its status.'),
  }
}
