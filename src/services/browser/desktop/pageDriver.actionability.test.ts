import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './pageDriver.testSupport'

it('rejects moving targets before dispatching input', async () => {
  let boxes = 0
  const { observe, execute, contents } = await setupGuest(async method => {
    if (method === 'DOM.getContentQuads') { const x = ++boxes * 10; return { quads: [[x, 0, x + 100, 0, x + 100, 40, x, 40]] } }
  })
  const observation = await observe()
  expect(await execute('click', { target: observation.elements[0].id, observationId: observation.observationId, timeoutMs: 0 })).toMatchObject({ error: 'element-not-stable' })
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
})

it('clicks the first line of an element wrapped across lines', async () => {
  const { observe, execute, contents } = await setupGuest(async method => {
    if (method === 'DOM.getContentQuads') return { quads: [[0, 0, 0, 0, 0, 0, 0, 0], [20, 20, 300, 20, 300, 40, 20, 40], [20, 40, 50, 40, 50, 60, 20, 60]] }
  })
  const observation = await observe()
  expect(await execute('click', { target: observation.elements[0].id, observationId: observation.observationId })).toMatchObject({ cursor: { x: 160, y: 30 } })
  expect(contents.debugger.sendCommand.mock.calls.find(([method]) => method === 'Input.dispatchMouseEvent')?.[1]).toMatchObject({ x: 160, y: 30 })
})

it('waits for a covering element to go away and names it while it stays', async () => {
  let covered = 2
  const actionable = (fn: string) => fn.includes('element-obscured: covered by')
  const { observe, execute, contents } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && actionable(String(params.functionDeclaration)) && covered > 0) {
      covered--
      return { result: { value: 'element-obscured: covered by <div#consent> "Accept cookies"' } }
    }
  })
  const observation = await observe()
  expect(await execute('click', { target: observation.elements[0].id, observationId: observation.observationId })).toMatchObject({ result: { action: { method: 'click' } } })
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchMouseEvent').length).toBeGreaterThan(0)

  covered = Infinity
  const failed = await execute('click', { target: observation.elements[0].id, observationId: observation.observationId, timeoutMs: 300 })
  expect(failed).toMatchObject({ error: 'element-obscured: covered by <div#consent> "Accept cookies"', recovery: expect.stringContaining('dismiss') })
})

it('reports a failed checked-state postcondition', async () => {
  const { observe, execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && /typeof this.checked|Boolean\(this.checked\);/.test(String(params.functionDeclaration))) return { result: { value: false } }
  })
  const observation = await observe()
  expect(await execute('setChecked', { target: observation.elements[0].id, checked: true, observationId: observation.observationId })).toMatchObject({ error: 'browser-check-postcondition-failed' })
})
