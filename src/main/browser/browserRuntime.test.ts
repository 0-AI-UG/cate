import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest, identity } from './browserRuntime.testSupport'

it('binds every operation to the full guest identity', async () => {
  const { runtime, contents } = await setupGuest()
  expect(await runtime.execute(contents.id, { ...identity, tabId: 'other' }, 'getAXState', {})).toEqual({ error: 'browser-target-not-registered' })
})

it('invalidates numeric IDs and observations on navigation', async () => {
  const { observe, execute, events } = await setupGuest()
  const before = await observe()
  events.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'new' } })
  expect(await execute('click', { target: before.elements[0].id, observationId: before.observationId })).toMatchObject({ error: 'stale-browser-observation' })
  const after = await observe()
  expect(after.documentId).not.toBe(before.documentId)
  expect(after.elements[0].id).not.toBe(before.elements[0].id)
})

it('requires grounded IDs and rejects CSS targets', async () => {
  const { observe, execute } = await setupGuest()
  const observation = await observe()
  for (const target of ['#save', 999]) expect(await execute('click', { target, observationId: observation.observationId })).toMatchObject({ error: 'browser-element-not-in-observation' })
  expect(await execute('click', { target: observation.elements[0].id })).toMatchObject({ error: 'browser-observation-required' })
})

it('returns a new observation after a dispatched action, without claiming business success', async () => {
  const { observe, execute } = await setupGuest()
  const observation = await observe()
  const action = await execute('click', { target: [20, 20], observationId: observation.observationId })
  expect(action).toMatchObject({ result: { action: { method: 'click', status: 'dispatched' }, observation: { documentId: observation.documentId, elements: [{ id: observation.elements[0].id }] } } })
})

it('rejects coordinate actions after viewport changes before dispatching input', async () => {
  const { observe, execute, state, contents } = await setupGuest()
  const observation = await observe(); state.viewport.scrollY = 20
  expect(await execute('click', { target: [20, 20], observationId: observation.observationId })).toMatchObject({ error: 'stale-browser-coordinates' })
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchMouseEvent')).toBe(false)
})

it('keeps cross-origin frame IDs bound to their CDP session', async () => {
  const { observe, execute, events, contents } = await setupGuest(async (method, params, sessionId) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'cross', parentId: 'main' } }] } }
    if (method === 'Accessibility.getFullAXTree') return { nodes: sessionId === 'cross-session' ? [{ backendDOMNodeId: 9, role: { value: 'checkbox' }, name: { value: 'Cross' } }] : [] }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('typeof this.checked')) return { result: { value: false } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('Boolean(this.checked);')) return { result: { value: false } }
  })
  events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'cross-session', targetInfo: { type: 'iframe', targetId: 'cross' } })
  const observation = await observe()
  expect(await execute('setChecked', { target: observation.elements[0].id, checked: false, observationId: observation.observationId })).toMatchObject({ result: { action: { status: 'verified' } } })
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.resolveNode', expect.objectContaining({ backendNodeId: 9 }), 'cross-session')
})

it('uploads an authorized file without exposing its host path in the result', async () => {
  const { observe, execute, contents } = await setupGuest(async (method, params) => {
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes('file: this instanceof')) return { result: { value: { file: true, enabled: true } } }
    if (fn.includes('this.files?.[0]')) return { result: { value: { name: 'report.pdf', size: 42, count: 1 } } }
  })
  const observation = await observe()
  const result = await execute('upload', { target: observation.elements[0].id, filePath: '/authorized/private/report.pdf', observationId: observation.observationId })
  expect(result).toMatchObject({ result: { action: { method: 'upload', status: 'verified' } } })
  expect(JSON.stringify(result)).not.toContain('/authorized/private')
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', { files: ['/authorized/private/report.pdf'], backendNodeId: 7 }, undefined)
})

it('keeps native wheel input marked through document acknowledgement and observes its result', async () => {
  let started!: () => void, release!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const { observe, execute, contents, state } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('return this.promise')) { started(); await new Promise<void>(resolve => { release = resolve }); state.viewport.scrollY = 400; return { result: { value: true } } }
  })
  const observation = await observe()
  const pending = execute('scroll', { target: [20, 20], direction: 'down', pages: 1, observationId: observation.observationId })
  await entered
  expect(contents.send).toHaveBeenLastCalledWith('cate-browser-automation-input', true)
  release()
  expect(await pending).toMatchObject({ result: { observation: { viewport: { scrollY: 400 } } } })
  expect(contents.send).toHaveBeenLastCalledWith('cate-browser-automation-input', false)
})

it('releases temporary CDP handles after every operation while numeric IDs stay usable', async () => {
  const { observe, execute, contents, events } = await setupGuest()
  events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'child-session', targetInfo: { type: 'iframe', targetId: 'child' } })
  const observation = await observe()
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.releaseObjectGroup', { objectGroup: 'cate-browser' }, undefined)
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Runtime.releaseObjectGroup', { objectGroup: 'cate-browser' }, 'child-session')
  expect(await execute('setChecked', { target: observation.elements[0].id, checked: false, observationId: observation.observationId })).toMatchObject({ result: { action: { status: 'verified' }, observation: { elements: [{ id: observation.elements[0].id }] } } })
  const before = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.releaseObjectGroup').length
  expect(await execute('click', { target: 999, observationId: observation.observationId })).toHaveProperty('error')
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Runtime.releaseObjectGroup')).toHaveLength(before + 2)
})

it.each(['setValue', 'typeText'])('returns positional typing feedback for %s without exposing entered text', async method => {
  const { observe, execute } = await setupGuest()
  const observation = await observe()
  const result = await execute(method, { observationId: observation.observationId, target: observation.elements[0].id, value: 'private text', text: 'private text' })
  expect(result).toMatchObject({ cursor: { x: 70, y: 40, kind: 'type', label: method } })
  expect(JSON.stringify(result.cursor)).not.toContain('private text')
  expect(result.cursor).not.toHaveProperty('rect')
})

it('keeps a successful edit when the field no longer has cursor geometry', async () => {
  const { observe, execute } = await setupGuest(async method => {
    if (method === 'DOM.getBoxModel') throw new Error('Node has been removed')
  })
  const observation = await observe()
  expect(await execute('setValue', { observationId: observation.observationId, target: observation.elements[0].id, value: 'text' }))
    .toMatchObject({ result: { action: { status: 'verified' } } })
})
