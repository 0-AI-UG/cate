import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const settings = vi.hoisted(() => ({ key: 'saved-test-key' }))
vi.mock('../settingsFile', () => ({ getSetting: () => settings.key }))
import { requestJevDecision } from './jevDecision'
const providerFetch = vi.fn()
const request = { state: { goal: 'Click Save' }, instructions: 'Choose an action', criteria: { click: 'Click', done: 'Done' } }
beforeEach(() => {
  settings.key = 'saved-test-key'
  providerFetch.mockReset()
  vi.stubGlobal('fetch', providerFetch)
})
afterEach(() => vi.unstubAllGlobals())

it('uses the saved key and fixes the endpoint and model independently of CLI arguments', async () => {
  const answer = { answers: { decision: { type: 'choice', choice: 'done', confidence: 1, probabilities: { done: 1 } } } }
  providerFetch.mockResolvedValue(new Response(JSON.stringify(answer)))
  expect(await requestJevDecision({ ...request, apiKey: 'injected', model: 'another-model', url: 'https://other.test' })).toEqual(answer)
  const [url, init] = providerFetch.mock.calls[0]
  expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
  expect(init.headers.Authorization).toBe('Bearer saved-test-key')
  expect(JSON.parse(init.body)).toEqual({ model: 'typesafe/jev-1.13', state: request.state, questions: { decision: { type: 'choice', instructions: request.instructions, criteria: request.criteria } } })
  expect(init.signal).toBeInstanceOf(AbortSignal)
})

it('uses updated settings and blocks without networking after the key is cleared', async () => {
  settings.key = ' replacement-key '
  providerFetch.mockResolvedValue(new Response('{}'))
  await requestJevDecision(request)
  expect(providerFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer replacement-key')
  settings.key = ''
  expect(await requestJevDecision(request)).toEqual({ error: 'Set the OpenRouter API key in Cate Settings → CLI.' })
  expect(providerFetch).toHaveBeenCalledTimes(1)
})

it.each([null, {}, { ...request, criteria: { only: 'one' } }, { ...request, criteria: { a: 1, b: 'two' } }])('rejects malformed decisions before contacting OpenRouter', async args => {
  expect(await requestJevDecision(args)).toHaveProperty('error')
  expect(providerFetch).not.toHaveBeenCalled()
})

it('does not expose provider errors or network exception details', async () => {
  providerFetch.mockResolvedValueOnce(new Response('saved-test-key private page', { status: 401 }))
  expect(await requestJevDecision(request)).toEqual({ error: 'OpenRouter Jev request failed (HTTP 401)' })
  providerFetch.mockRejectedValueOnce(new Error('saved-test-key private page'))
  expect(await requestJevDecision(request)).toEqual({ error: 'OpenRouter Jev request failed or timed out.' })
})
