// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './browserRuntime.testSupport'

it('rejects ambiguous text and honors adjacent prefix/suffix when selecting', async () => {
  const input = document.createElement('input'); input.value = 'one cat two cat end'; document.body.append(input)
  const { observe, execute } = await setupGuest(async (method, params) => {
    const fn = String(params.functionDeclaration)
    if (method === 'Runtime.callFunctionOn' && fn.includes('const text=')) {
      return { result: { value: new Function('target', `return (${fn}).call(target)`)(input) } }
    }
  })
  const observation = await observe()
  const base = { observationId: observation.observationId, target: observation.elements[0].id, text: 'cat' }
  expect(await execute('selectText', base)).toMatchObject({ error: 'browser-selection-ambiguous' })
  expect(await execute('selectText', { ...base, prefix: 'two ', suffix: ' end' })).toMatchObject({ result: { action: { status: 'verified' } } })
  expect([input.selectionStart, input.selectionEnd]).toEqual([12, 15])
  input.remove()
})
