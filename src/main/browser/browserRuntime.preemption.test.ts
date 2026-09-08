import { afterEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './browserRuntime.testSupport'
import { beginBrowserCodeCell, endBrowserCodeCell } from './browserCodeExecution'
afterEach(() => vi.useRealTimers())
const preempted = { error: 'browser-action-preempted-by-user' }

it('invalidates already queued work, while accepting new work after takeover', async () => {
  let pending = false, release!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const { observe, execute, runtime, contents } = await setupGuest(async (method) => {
    if (pending && method === 'Accessibility.getFullAXTree') { started(); await new Promise<void>(resolve => { release = resolve }); pending = false }
  })
  const observation = await observe(); pending = true
  const first = execute('getAXState'); await entered
  const queued = execute('click', { target: [20, 20], observationId: observation.observationId })
  runtime.noteUserInput(contents.id); release(); await first
  expect(await queued).toMatchObject(preempted)
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
  expect(await execute('click', { target: [20, 20], observationId: observation.observationId })).not.toHaveProperty('error')
})

it.each([{ text: 'Ready' }, { url: '*ready*' }, { element: 1, state: 'hidden' }])('cancels waitFor %j on next poll', async condition => {
  vi.useFakeTimers()
  const { observe, execute, runtime, contents } = await setupGuest()
  const observation = await observe()
  const result = vi.fn()
  const pending = execute('waitFor', { condition, observationId: observation.observationId, timeoutMs: 30000 }).then(result)
  await vi.advanceTimersByTimeAsync(1); runtime.noteUserInput(contents.id); await vi.advanceTimersByTimeAsync(100)
  expect(result).toHaveBeenCalledWith(expect.objectContaining(preempted)); await pending
})

it.each(['mouseMoved', 'mousePressed'])('handles takeover after %s and releases pressed input', async phase => {
  let lastInputType: unknown
  const { observe, execute, runtime, contents } = await setupGuest(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent') lastInputType = params.type
  })
  const observation = await observe()
  contents.send.mockImplementation((_channel, active) => {
    if (!active && lastInputType === phase) queueMicrotask(() => runtime.noteUserInput(contents.id))
  })
  expect(await execute('click', { target: [20, 20], observationId: observation.observationId })).toMatchObject(preempted)
  const types = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params?.type)
  expect(types).toEqual(phase === 'mouseMoved' ? ['mouseMoved'] : ['mouseMoved', 'mousePressed', 'mouseReleased'])
})

it.each(['mouseMoved', 'mousePressed'])('cancels an active code cell after %s while preserving paired releases', async phase => {
  const cellId = `cancel-${phase}`
  beginBrowserCodeCell(cellId, Date.now() + 5000)
  try {
    const { observe, execute, contents } = await setupGuest(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params.type === phase) endBrowserCodeCell(cellId)
    })
    const observation = await observe()
    expect(await execute('click', { target: [20, 20], observationId: observation.observationId, _codeCellId: cellId }))
      .toMatchObject({ error: 'browser-code-cell-cancelled' })
    const types = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').map(([, params]) => params?.type)
    expect(types).toEqual(phase === 'mouseMoved' ? ['mouseMoved'] : ['mouseMoved', 'mousePressed', 'mouseReleased'])
  } finally { endBrowserCodeCell(cellId) }
})
