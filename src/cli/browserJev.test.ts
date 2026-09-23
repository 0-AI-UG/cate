import { describe, expect, it, vi } from 'vitest'
import { runBrowserJev } from './browserJev'
import type { BrowserObservation } from '../shared/browserAutomation'

function fixture(decisions: Array<string | { word: string }>, overrides: Partial<BrowserObservation> = {}) {
  let observation = {
    kind: 'ax', panelId: 'browser', tabId: 'tab', documentId: 'doc', observationId: 'o1', userInputEpoch: 0,
    url: 'https://example.test', title: 'Form', state: 'textbox Name, button Save', diff: false,
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, zoom: 1, deviceScaleFactor: 1 },
    elements: [{ id: 1, role: 'textbox', name: 'Name' }, { id: 2, role: 'button', name: 'Save' }],
    ...overrides,
  } as BrowserObservation
  const invoke = vi.fn(async (method: string, args: Record<string, unknown>) => {
    if (method.endsWith('getTab')) return { panelId: 'browser', tabId: 'tab' }
    if (method.endsWith('setValue')) observation = { ...observation, state: `textbox Name value ${args.value}, button Save` }
    if (method.endsWith('click')) observation = { ...observation, state: 'Saved successfully' }
    if (method.endsWith('getAXStateAndScreenshot')) return { ...observation, screenshot: { mimeType: 'image/png', data: 'cG5n', width: 800, height: 600 } }
    return observation
  })
  const decide = vi.fn(async (request: { state: any; instructions: string; criteria: Record<string, string> }) => {
    const next = decisions.shift()
    const criteria = request.criteria
    const choice = typeof next === 'string' ? next : Object.keys(criteria).find(key => criteria[key] === next?.word)
    return { answers: { decision: { type: 'choice', choice, probabilities: { [choice!]: 1 }, confidence: 1 } } }
  })
  const options = { prompt: 'Write Hi in Name and save', panelId: 'browser', maxSteps: 5, decide, invoke }
  return { options, decide, invoke }
}

describe('Jev browser control', () => {
  it('selects a prompt word, types once, clicks, and verifies completion through OpenRouter', async () => {
    const { options, invoke } = fixture(['setValue', 'c0', { word: 'Hi' }, 'click', 'c0', 'done'])
    const result = await runBrowserJev(options)
    expect(result).toMatchObject({ status: 'done', isError: false, modelCalls: 6, actions: [{ method: 'setValue', target: 1 }, { method: 'click', target: 2 }] })
    expect(result.observation).toMatchObject({ state: 'Saved successfully', screenshot: { data: 'cG5n' } })
    expect(invoke.mock.calls.at(-1)?.[0]).toBe('cate.browser.getAXStateAndScreenshot')
    expect(invoke).toHaveBeenCalledWith('cate.browser.setValue', expect.objectContaining({ value: 'Hi', target: 1, panelId: 'browser', tabId: 'tab', _userInputEpoch: 0 }))
    expect(invoke.mock.calls.filter(([method]) => method.endsWith('setValue'))).toHaveLength(1)
  })

  it.each([
    { error: 'browser-screenshot-failed' },
    { kind: 'ax', panelId: 'browser', tabId: 'tab', state: 'Saved successfully' },
  ])('reports a failed final capture without returning stale AX state', async finalRead => {
    const { options, invoke } = fixture(['done'])
    const original = invoke.getMockImplementation()!
    invoke.mockImplementation((method, args) => method.endsWith('getAXStateAndScreenshot')
      ? Promise.resolve(finalRead as never) : original(method, args))
    const result = await runBrowserJev(options)
    expect(result).toMatchObject({ status: 'done', isError: true, observationError: expect.any(String) })
    expect(result.observation).toBeUndefined()
    expect(result.url).toBeUndefined()
    expect(invoke.mock.calls.at(-1)?.[0]).toBe('cate.browser.getAXStateAndScreenshot')
  })

  it('offers distinct whitespace-separated words verbatim, preserving punctuation and Unicode', async () => {
    const { options, decide, invoke } = fixture(['setValue', 'c0', { word: 'café!' }, 'done'])
    const result = await runBrowserJev({ ...options, prompt: '  Enter\tcafé!\ninto Name café!  ' })
    expect(result).toMatchObject({ status: 'done', modelCalls: 4 })
    const criteria = decide.mock.calls[2][0].criteria
    expect(Object.values(criteria)).toEqual(['No suitable option', 'Enter', 'café!', 'into', 'Name'])
    expect(invoke).toHaveBeenCalledWith('cate.browser.setValue', expect.objectContaining({ value: 'café!' }))
  })

  it('offers individual words instead of multiword spans or character options', async () => {
    const { options, decide, invoke } = fixture(['setValue', 'c0', 'none'])
    expect(await runBrowserJev({ ...options, prompt: 'Enter Alan Turing in Name' })).toMatchObject({ status: 'blocked', modelCalls: 3 })
    const criteria = decide.mock.calls[2][0].criteria
    expect(Object.values(criteria)).toEqual(['No suitable option', 'Enter', 'Alan', 'Turing', 'in', 'Name'])
    expect(invoke.mock.calls.some(([method]) => method.endsWith('setValue'))).toBe(false)
  })

  it('bounds article context while retaining viewport evidence after lengthy offscreen content', async () => {
    const state = `${'- paragraph lengthy content [offscreen]\n'.repeat(10_000)}- heading "Alan Turing" [id=1]`
    const { options, decide } = fixture(['done'], { state })
    expect(await runBrowserJev(options)).toMatchObject({ status: 'done' })
    const sent = decide.mock.calls[0][0].state.page.state
    expect(sent.length).toBeLessThan(16_100)
    expect(sent).toContain('heading "Alan Turing"')
    expect(sent).toContain('additional content omitted')
  })

  it('does not generate text when no prompt word fits the field', async () => {
    const { options, invoke, decide } = fixture(['setValue', 'c0', 'none'])
    expect(await runBrowserJev(options)).toMatchObject({ status: 'blocked', isError: true, modelCalls: 3 })
    expect(invoke.mock.calls.some(([method]) => method.endsWith('setValue'))).toBe(false)
    expect(decide).toHaveBeenCalledTimes(3)
  })

  it('requires an explicit HTTP or HTTPS URL instead of generating a destination', async () => {
    const { options, invoke } = fixture(['goto'])
    expect(await runBrowserJev({ ...options, prompt: 'Go to Wikipedia' })).toMatchObject({ status: 'blocked', modelCalls: 1, message: expect.stringContaining('destination URL') })
    expect(invoke.mock.calls.some(([method]) => method.endsWith('goto'))).toBe(false)
  })

  it('selects an explicit destination as a whole URL instead of generating its characters', async () => {
    const { options, invoke, decide } = fixture(['goto', 'c0', 'done'])
    const progress = vi.fn()
    const result = await runBrowserJev({ ...options, prompt: 'Go to https://example.com and finish when the Example Domain heading is visible.', progress })
    expect(result).toMatchObject({ status: 'done', modelCalls: 3 })
    expect(invoke).toHaveBeenCalledWith('cate.browser.goto', expect.objectContaining({ url: 'https://example.com' }))
    expect(decide.mock.calls.every(([request]) => request.state.textSoFar === undefined)).toBe(true)
    expect(progress).toHaveBeenCalledWith('Jev: choosing destination URL from the prompt…')
  })

  it('lets Jev choose between URLs and removes surrounding prose punctuation', async () => {
    const { options, invoke } = fixture(['goto', 'c1', 'done'])
    const result = await runBrowserJev({ ...options, prompt: 'Skip https://first.test, and go to (https://second.test/search?q=cat&lang=en).' })
    expect(result.status).toBe('done')
    expect(invoke).toHaveBeenCalledWith('cate.browser.goto', expect.objectContaining({ url: 'https://second.test/search?q=cat&lang=en' }))
  })

  it('does not generate another destination when Jev rejects the supplied URLs', async () => {
    const { options, invoke } = fixture(['goto', 'none'])
    expect(await runBrowserJev({ ...options, prompt: 'Go to https://example.com' })).toMatchObject({ status: 'blocked', modelCalls: 2 })
    expect(invoke.mock.calls.some(([method]) => method.endsWith('goto'))).toBe(false)
  })

  it('rejects a choice outside the code-owned action set', async () => {
    const { options, invoke } = fixture(['arbitrary-code'])
    expect(await runBrowserJev(options)).toMatchObject({ status: 'error', message: 'Invalid OpenRouter Jev Choice response' })
    expect(invoke.mock.calls.every(([method]) => method.endsWith('getTab') || method.endsWith('getAXState') || method.endsWith('getAXStateAndScreenshot'))).toBe(true)
  })

  it('stops on low confidence and does not repeat provider failures', async () => {
    for (const response of [
      { answers: { decision: { type: 'choice', choice: 'click', probabilities: { click: 0.4 }, confidence: 0.1 } } },
      { error: 'OpenRouter Jev request failed (HTTP 429)' },
    ]) {
      const { options, invoke, decide } = fixture([])
      decide.mockResolvedValueOnce(response as never)
      const result = await runBrowserJev(options)
      expect(result.isError).toBe(true)
      expect(decide).toHaveBeenCalledTimes(1)
      expect(invoke.mock.calls.some(([method]) => method.endsWith('click'))).toBe(false)
    }
  })

  it('enforces the step budget without another action', async () => {
    const { options, invoke } = fixture(['click', 'c0', 'click'])
    expect(await runBrowserJev({ ...options, maxSteps: 1 })).toMatchObject({ status: 'step_limit', actions: [{ method: 'click', target: 2 }] })
    expect(invoke.mock.calls.filter(([method]) => method.endsWith('click'))).toHaveLength(1)
  })

  it('keeps all targets selectable when more than 254 are present', async () => {
    const elements = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, role: 'button', name: `Button ${i + 1}` }))
    const { options, invoke, decide } = fixture(['click', 'g1', 'c299', 'done'], { elements })
    expect(await runBrowserJev(options)).toMatchObject({ status: 'done' })
    expect(invoke).toHaveBeenCalledWith('cate.browser.click', expect.objectContaining({ target: 300 }))
    for (const [request] of decide.mock.calls) expect(Object.keys(request.criteria).length).toBeLessThanOrEqual(255)
  })

  it('keeps words beyond the first choice group selectable', async () => {
    const prompt = Array.from({ length: 300 }, (_, index) => `word${index}`).join(' ')
    const { options, invoke } = fixture(['setValue', 'c0', 'g1', 'c299', 'done'])
    expect(await runBrowserJev({ ...options, prompt })).toMatchObject({ status: 'done' })
    expect(invoke).toHaveBeenCalledWith('cate.browser.setValue', expect.objectContaining({ value: 'word299' }))
  })

  it('does not type when the user takes over during word selection', async () => {
    const { options, invoke } = fixture(['setValue', 'c0', { word: 'Hi' }])
    const original = options.invoke.getMockImplementation()!
    let reads = 0
    invoke.mockImplementation(async (method, args) => {
      if (method.endsWith('getAXState') && ++reads === 2) return { error: 'browser-action-preempted-by-user' } as never
      return original(method, args)
    })
    expect(await runBrowserJev(options)).toMatchObject({ status: 'error', message: 'browser-action-preempted-by-user' })
    expect(invoke.mock.calls.some(([method]) => method.endsWith('setValue'))).toBe(false)
  })

  it('continues typing through unrelated page updates and automatic field focus', async () => {
    const { options, invoke } = fixture(['setValue', 'c0', { word: 'Hi' }, 'done'])
    const original = invoke.getMockImplementation()!
    let reads = 0
    invoke.mockImplementation(async (method, args) => {
      const result = await original(method, args)
      if (method.endsWith('getAXState') && ++reads > 1) {
        const page = result as BrowserObservation
        return { ...page, state: `${page.state}\nBackground content loaded`, elements: page.elements.map(element => element.id === 1 ? { ...element, states: { focused: true } } : element) }
      }
      return result
    })
    expect(await runBrowserJev(options)).toMatchObject({ status: 'done' })
    expect(invoke).toHaveBeenCalledWith('cate.browser.setValue', expect.objectContaining({ value: 'Hi', target: 1 }))
  })

  it.each(['document', 'removed', 'name', 'value', 'readonly', 'disabled'])('does not overwrite a changed field (%s) after selecting a word', async change => {
    const { options, invoke } = fixture(['setValue', 'c0', { word: 'Hi' }, 'done'])
    const original = invoke.getMockImplementation()!
    let reads = 0
    invoke.mockImplementation(async (method, args) => {
      const result = await original(method, args)
      if (method.endsWith('getAXState') && ++reads >= 2) {
        const page = result as BrowserObservation
        if (change === 'document') return { ...page, documentId: 'replacement-document' }
        return { ...page, elements: page.elements.flatMap(element => {
          if (element.id !== 1) return [element]
          if (change === 'removed') return []
          if (change === 'name') return [{ ...element, name: 'Different purpose' }]
          if (change === 'value') return [{ ...element, value: 'Updated by the page' }]
          return [{ ...element, states: { [change]: true } }]
        }) }
      }
      return result
    })
    expect(await runBrowserJev(options)).toMatchObject({ status: 'blocked' })
    expect(invoke.mock.calls.some(([method]) => method.endsWith('setValue'))).toBe(false)
  })
})
