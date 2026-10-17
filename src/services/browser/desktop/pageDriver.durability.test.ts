import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './pageDriver.testSupport'

it('fails a call on a page that stopped answering, fails the next at once, and restarts the page', async () => {
  vi.useFakeTimers()
  try {
    let hung = false
    const { observe, execute, runtime, contents } = await setupGuest(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') hung = true
      if (hung) return new Promise(() => {})
    })
    const observation = await observe()
    const click = execute('click', { target: observation.elements[0].id, observationId: observation.observationId })
    // The actionability checks run first, then the press waits 10 s.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(await click).toMatchObject({ error: 'browser-page-unresponsive', recovery: expect.stringContaining('cate browser reload') })

    // The next call asks the page once, briefly, instead of queueing behind it.
    const next = execute('getAXState')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await next).toMatchObject({ error: 'browser-page-unresponsive' })

    contents.once.mockImplementation((event: string, listener: () => void) => { if (event === 'render-process-gone') listener() })
    expect(await runtime.restartIfHung(contents.id)).toBe(true)
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalled()
    expect(contents.reload).toHaveBeenCalled()
    hung = false
    expect(await execute('getAXState')).toHaveProperty('result')
    expect(await runtime.restartIfHung(contents.id)).toBe(false)
  } finally { vi.useRealTimers() }
})

it('carries on once a busy page answers again', async () => {
  vi.useFakeTimers()
  try {
    let busy = true
    const { observe, execute } = await setupGuest(async method => {
      if (busy && method === 'Accessibility.getFullAXTree') return new Promise(() => {})
    })
    const first = observe().catch(() => undefined)
    const pending = execute('getAXState')
    await vi.advanceTimersByTimeAsync(10_000)
    await first
    expect(await pending).toMatchObject({ error: 'browser-page-unresponsive' })
    busy = false
    expect(await execute('getAXState')).toHaveProperty('result')
  } finally { vi.useRealTimers() }
})

it('scrolls a covered element to other alignments before giving up on it', async () => {
  const scrolls: string[] = []
  let covered = true
  const { observe, execute } = await setupGuest(async (method, params) => {
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes('scrollIntoView({ block:')) { scrolls.push(fn.match(/block: "(\w+)"/)![1]); covered = scrolls.length < 2; return { result: {} } }
    if (fn.includes('element-obscured: covered by') && covered) return { result: { value: 'element-obscured: covered by <div#footer>' } }
  })
  const observation = await observe()
  expect(await execute('click', { target: observation.elements[0].id, observationId: observation.observationId })).toMatchObject({ result: { action: { method: 'click' } } })
  expect(scrolls).toEqual(['center', 'start'])
})

it('accepts an id from an earlier snapshot of the same page and rejects ids it never issued', async () => {
  const { observe, execute, state } = await setupGuest()
  const first = await observe()
  state.nodes = [...state.nodes, { nodeId: 'other', backendDOMNodeId: 8, role: { value: 'button' }, name: { value: 'Other' } }]
  const second = await observe()
  expect(second.elements.map(element => element.id)).toContain(first.elements[0].id)
  expect(await execute('click', { target: first.elements[0].id, observationId: second.observationId })).toHaveProperty('result')
  expect(await execute('click', { target: 999, observationId: second.observationId })).toMatchObject({ error: 'browser-unknown-element' })
})
