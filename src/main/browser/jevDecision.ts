import { getSetting } from '../settingsFile'

/** Keep the saved credential and provider requests in Cate, including for remote CLIs. */
export async function requestJevDecision(args: unknown): Promise<unknown> {
  const apiKey = getSetting('cliOpenRouterApiKey').trim()
  if (!apiKey) return { error: 'Set the OpenRouter API key in Cate Settings → CLI.' }
  if (!args || typeof args !== 'object') return { error: 'Invalid Jev decision request.' }
  const { state, instructions, criteria } = args as Record<string, unknown>
  if (typeof instructions !== 'string' || !criteria || typeof criteria !== 'object' || Array.isArray(criteria)) {
    return { error: 'Invalid Jev decision request.' }
  }
  const choices = Object.entries(criteria)
  if (choices.length < 2 || choices.length > 255 || choices.some(([, value]) => typeof value !== 'string')) {
    return { error: 'Invalid Jev choice count or criteria.' }
  }
  try {
    const response = await fetch('https://openrouter.ai/api/alpha/decisions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'X-OpenRouter-Title': 'Cate' },
      body: JSON.stringify({
        model: 'typesafe/jev-1.13', state,
        questions: { decision: { type: 'choice', instructions, criteria } },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    // Provider errors can echo credentials or page data. Return only the status.
    if (!response.ok) return { error: `OpenRouter Jev request failed (HTTP ${response.status})` }
    return await response.json()
  } catch {
    return { error: 'OpenRouter Jev request failed or timed out.' }
  }
}
