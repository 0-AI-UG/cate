import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './browserRuntime.testSupport'

it('rejects moving targets before dispatching input', async () => {
  let boxes = 0
  const { observe, execute, contents } = await setupGuest(async method => {
    if (method === 'DOM.getBoxModel') { const x = ++boxes * 10; return { model: { content: [x, 0, x + 100, 0, x + 100, 40, x, 40] } } }
  })
  const observation = await observe()
  expect(await execute('click', { target: observation.elements[0].id, observationId: observation.observationId })).toMatchObject({ error: 'element-not-stable' })
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
})

it('reports a failed checked-state postcondition', async () => {
  const { observe, execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && /typeof this.checked|Boolean\(this.checked\);/.test(String(params.functionDeclaration))) return { result: { value: false } }
  })
  const observation = await observe()
  expect(await execute('setChecked', { target: observation.elements[0].id, checked: true, observationId: observation.observationId })).toMatchObject({ error: 'browser-check-postcondition-failed' })
})
