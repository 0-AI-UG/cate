import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest } from './pageDriver.testSupport'

const page = [
  { nodeId: 'save', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Save' } },
  { nodeId: 'draft', backendDOMNodeId: 8, role: { value: 'button' }, name: { value: 'Save draft' } },
  { nodeId: 'email', backendDOMNodeId: 9, role: { value: 'textbox' }, name: { value: 'Email' }, properties: [{ name: 'disabled', value: { value: true } }] },
]

async function guest() {
  const setup = await setupGuest()
  setup.state.nodes = page
  return setup
}

const touched = (contents: Awaited<ReturnType<typeof setupGuest>>['contents']) =>
  new Set(contents.debugger.sendCommand.mock.calls.map(([, params]) => (params as Record<string, unknown> | undefined)?.backendNodeId).filter((id) => id !== undefined))

it('acts on the one element a locator finds', async () => {
  const { execute, contents } = await guest()
  expect(await execute('click', { role: 'button', name: 'Save', exact: true })).toMatchObject({ result: { action: { method: 'click' } } })
  expect(touched(contents).has(7)).toBe(true)
  expect(touched(contents).has(8)).toBe(false)
})

it('lists the matches of an ambiguous locator', async () => {
  const { execute } = await guest()
  const { error, recovery } = await execute('click', { role: 'button', name: 'save' })
  expect(error).toMatch(/^browser-ambiguous-element: 2 elements match role=button name~"save":\n- button "Save" \[id=\d+\]\n- button "Save draft" \[id=\d+\]$/)
  expect(recovery).toMatch(/--exact/)
})

it('fails when nothing matches in time, and refuses an id with a locator', async () => {
  const { execute, contents } = await guest()
  expect(await execute('click', { name: 'Delete', timeoutMs: 0 })).toMatchObject({ error: 'browser-no-matching-element: nothing on the page matches name~"Delete"' })
  expect(await execute('click', { target: 1, name: 'Save' })).toMatchObject({ error: 'browser-target-or-locator' })
  expect(await execute('click', {})).toMatchObject({ error: 'browser-target-required' })
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
})

it('finds elements without acting', async () => {
  const { execute } = await guest()
  const { result } = await execute('find', { role: 'button' })
  expect((result as { elements: Array<{ name: string }> }).elements.map((element) => element.name)).toEqual(['Save', 'Save draft'])
  expect(await execute('find', {})).toMatchObject({ error: 'browser-locator-required' })
})

it('waits for a located element to reach a state', async () => {
  const { execute } = await guest()
  expect(await execute('waitFor', { name: 'Email', state: 'disabled', timeoutMs: 1000 })).toMatchObject({ result: { action: { status: 'verified' } } })
  expect(await execute('waitFor', { name: 'Delete', state: 'hidden', timeoutMs: 1000 })).toMatchObject({ result: { action: { status: 'verified' } } })
  expect(await execute('waitFor', { name: 'Email', state: 'enabled', timeoutMs: 1 })).toMatchObject({ error: 'browser-wait-timeout' })
})
