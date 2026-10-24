import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { setupGuest, identity, domSnapshot } from './pageDriver.testSupport'
import { isAgentKeyInput } from './pageDriver'
import { GuestDialogs } from './dialogs'

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
  for (const target of ['#save', 999]) expect(await execute('click', { target, observationId: observation.observationId })).toMatchObject({ error: 'browser-unknown-element' })
  // Without an observation (a CLI call) the latest one grounds the id.
  expect(await execute('click', { target: observation.elements[0].id })).toMatchObject({ result: { action: { method: 'click' } } })
})

it('reads attributes from grounded AX elements', async () => {
  const { observe, execute } = await setupGuest(async (method, params) => {
    if (method !== 'Runtime.callFunctionOn' || !String(params.functionDeclaration).includes('this.getAttribute')) return
    const name = String(params.functionDeclaration).includes('"src"') ? 'src' : 'missing'
    return { result: { value: { element: true, value: name === 'src' ? '/image.png' : null } } }
  })
  const observation = await observe()
  const base = { target: observation.elements[0].id, observationId: observation.observationId }
  expect(await execute('getAttribute', { ...base, attribute: 'src' })).toEqual({ result: '/image.png' })
  expect(await execute('getAttribute', { ...base, attribute: 'missing' })).toEqual({ result: null })
  expect(await execute('getAttribute', { ...base, attribute: '' })).toMatchObject({ error: 'browser-attribute-name-required' })
  expect(await execute('getAttribute', { ...base, target: 999, attribute: 'src' })).toMatchObject({ error: 'browser-unknown-element' })
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

it('keeps coordinates valid while the page grows', async () => {
  const { observe, execute, state } = await setupGuest()
  const observation = await observe(); state.viewport.scrollHeight = 2400
  expect(await execute('click', { target: [20, 20], observationId: observation.observationId }))
    .toMatchObject({ result: { action: { status: 'dispatched' }, observation: { viewport: { scrollHeight: 2400 } } } })
})

it('keeps cross-origin frame IDs bound to their CDP session', async () => {
  const { observe, execute, events, contents } = await setupGuest(async (method, params, sessionId) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' }, childFrames: [{ frame: { id: 'cross', parentId: 'main' } }] } }
    if (method === 'Accessibility.getFullAXTree') return { nodes: sessionId === 'cross-session' ? [{ backendDOMNodeId: 9, role: { value: 'checkbox' }, name: { value: 'Cross' } }] : [] }
    if (method === 'DOMSnapshot.captureSnapshot' && sessionId === 'cross-session') return domSnapshot([9])
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('typeof this.checked')) return { result: { value: false } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('Boolean(this.checked);')) return { result: { value: false } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('this.getAttribute')) return { result: { value: { element: true, value: '/cross.png' } } }
  })
  events.emit('message', {}, 'Target.attachedToTarget', { sessionId: 'cross-session', targetInfo: { type: 'iframe', targetId: 'cross' } })
  const observation = await observe()
  expect(await execute('setChecked', { target: observation.elements[0].id, checked: false, observationId: observation.observationId })).toMatchObject({ result: { action: { status: 'verified' } } })
  expect(await execute('getAttribute', { target: observation.elements[0].id, attribute: 'src', observationId: observation.observationId })).toEqual({ result: '/cross.png' })
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.resolveNode', expect.objectContaining({ backendNodeId: 9 }), 'cross-session')
})

it('uploads authorized files without exposing their host paths in the result', async () => {
  const { observe, execute, contents } = await setupGuest(async (method, params) => {
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes("querySelectorAll('input[type=file]')")) return { result: { objectId: '7' } }
    if (fn.includes('multiple: this.multiple')) return { result: { value: { file: true, enabled: true, multiple: true } } }
    if (fn.includes('Array.from(this.files')) return { result: { value: ['report.pdf', 'notes.txt'] } }
  })
  const observation = await observe()
  const files = ['/authorized/private/report.pdf', '/authorized/private/notes.txt']
  const result = await execute('upload', { target: observation.elements[0].id, files, observationId: observation.observationId })
  expect(result).toMatchObject({ result: { action: { method: 'upload', status: 'verified' }, files: ['report.pdf', 'notes.txt'] } })
  expect(JSON.stringify(result)).not.toContain('/authorized/private')
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', { files, backendNodeId: 7 }, undefined)
})

it('refuses several files for an input that takes one', async () => {
  const { observe, execute, contents } = await setupGuest(async (method, params) => {
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes("querySelectorAll('input[type=file]')")) return { result: { objectId: '7' } }
    if (fn.includes('multiple: this.multiple')) return { result: { value: { file: true, enabled: true, multiple: false } } }
  })
  const observation = await observe()
  expect(await execute('upload', { target: observation.elements[0].id, files: ['/a', '/b'], observationId: observation.observationId }))
    .toMatchObject({ error: 'browser-upload-single-file-input' })
  expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything(), undefined)
})

it('clicks a button that opens a file chooser and fills the input the chooser belongs to', async () => {
  let events!: Awaited<ReturnType<typeof setupGuest>>['events']
  const { observe, execute, contents, ...guest } = await setupGuest(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      setTimeout(() => events.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 12, frameId: 'main', mode: 'selectSingle' }), 10)
      return {}
    }
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes("querySelectorAll('input[type=file]')")) return { result: { subtype: 'null' } }
    if (fn.includes('multiple: this.multiple')) return { result: { value: { file: true, enabled: true, multiple: false } } }
    if (fn.includes('Array.from(this.files')) return { result: { value: ['report.pdf'] } }
  })
  events = guest.events
  const observation = await observe()
  expect(await execute('upload', { target: observation.elements[0].id, files: ['/a/report.pdf'], observationId: observation.observationId }))
    .toMatchObject({ result: { action: { status: 'verified' }, files: ['report.pdf'] } })
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Page.setInterceptFileChooserDialog', { enabled: true }, undefined)
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', { files: ['/a/report.pdf'], backendNodeId: 12 }, undefined)
  expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Runtime.releaseObjectGroup', expect.anything(), undefined)
  expect(contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.setInterceptFileChooserDialog').map(([, params]) => params))
    .toEqual([{ enabled: true }, { enabled: false }])
})

it('reports a file chooser a click opened, and answers it with an upload without a target', async () => {
  let events!: Awaited<ReturnType<typeof setupGuest>>['events']
  const { observe, execute, contents, ...guest } = await setupGuest(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      events.emit('message', {}, 'Page.fileChooserOpened', { backendNodeId: 12, frameId: 'main', mode: 'selectMultiple' })
      return {}
    }
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes('multiple: this.multiple')) return { result: { value: { file: true, enabled: true, multiple: true } } }
    if (fn.includes('Array.from(this.files')) return { result: { value: ['a.txt'] } }
  })
  events = guest.events
  const observation = await observe()
  const clicked = await execute('click', { target: observation.elements[0].id, observationId: observation.observationId }) as { result: { action: { notices?: string[] } } }
  expect(clicked.result.action.notices?.join('\n')).toContain('cate browser upload chooser')
  expect(await execute('upload', { target: null, files: ['/a.txt'] })).toMatchObject({ result: { files: ['a.txt'] } })
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', { files: ['/a.txt'], backendNodeId: 12 }, undefined)
  expect(await execute('upload', { target: null, files: ['/a.txt'] })).toMatchObject({ error: 'browser-upload-no-file-chooser' })
})

it('drops files on a drop area', async () => {
  const { observe, execute, contents } = await setupGuest()
  const observation = await observe()
  expect(await execute('upload', { target: observation.elements[0].id, files: ['/a.txt'], drop: true, observationId: observation.observationId }))
    .toMatchObject({ result: { action: { status: 'dispatched' } } })
  const drags = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Input.dispatchDragEvent').map(([, params]) => params)
  expect(drags).toEqual(['dragEnter', 'dragOver', 'drop'].map(type => ({ type, x: 70, y: 40, data: { items: [], files: ['/a.txt'], dragOperationsMask: 1 } })))
})

it('hovers an element', async () => {
  const { observe, execute, contents } = await setupGuest()
  const observation = await observe()
  expect(await execute('hover', { target: observation.elements[0].id, observationId: observation.observationId }))
    .toMatchObject({ result: { action: { method: 'hover', status: 'dispatched' } }, cursor: { kind: 'hover', x: 70, y: 40 } })
  expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 70, y: 40 }, undefined)
  expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed' }), undefined)
})

it('fills a saved login into the page and never returns the password', async () => {
  const filled: string[] = []
  const { execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes("querySelectorAll('input[type=password]')")) return { result: { objectId: '21' } }
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes('this.form || this.ownerDocument.body')) return { result: { objectId: '20' } }
    if (fn.includes('location.origin')) return { result: { value: 'https://example.test' } }
    if (fn.includes('return this.value;')) return { result: { value: filled.at(-1) ?? '' } }
    const text = fn.match(/const text=(".*?");/)
    if (fn.includes('setter.call(this,text)') && text) { filled.push(JSON.parse(text[1])); return { result: { value: false } } }
  })
  const result = await execute('login', { credential: { username: 'me@example.test', password: 'hunter2', origin: 'https://example.test' } })
  expect(result).toMatchObject({ result: { action: { method: 'login', status: 'verified' } } })
  expect(filled).toEqual(['me@example.test', 'hunter2'])
  expect(JSON.stringify(result)).not.toContain('hunter2')
})

it('fills a new password into every empty password field and never returns it', async () => {
  const filled: string[] = []
  const { execute } = await setupGuest(async (method, params) => {
    // The password, then its confirmation; none once both are filled.
    const empty = () => (filled.length < 2 ? { result: { objectId: String(30 + filled.length) } } : { result: { subtype: 'null' } })
    if (method === 'Runtime.evaluate' && String(params.expression).includes('!field.value')) return empty()
    if (method !== 'Runtime.callFunctionOn') return
    const fn = String(params.functionDeclaration)
    if (fn.includes('!field.value')) return empty()
    if (fn.includes('location.origin')) return { result: { value: 'https://example.test' } }
    const text = fn.match(/const text=(".*?");/)
    if (fn.includes('setter.call(this,text)') && text) { filled.push(JSON.parse(text[1])); return { result: { value: false } } }
  })
  const result = await execute('signup', { credential: { password: 'n3w-Pass', origin: 'https://example.test' } })
  expect(result).toMatchObject({ result: { action: { method: 'signup', status: 'verified' } } })
  expect(filled).toEqual(['n3w-Pass', 'n3w-Pass'])
  expect(JSON.stringify(result)).not.toContain('n3w-Pass')
  expect(JSON.stringify(result)).toContain('2 password fields')
})

it('refuses a new password for a page of another origin', async () => {
  const { execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes('!field.value')) return { result: { objectId: '30' } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('location.origin')) return { result: { value: 'https://example.test' } }
  })
  expect(await execute('signup', { credential: { password: 'n3w-Pass', origin: 'https://bank.test' } })).toMatchObject({ error: 'browser-login-origin-mismatch' })
})

it('refuses a saved login for a field of another origin', async () => {
  const { execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes("querySelectorAll('input[type=password]')")) return { result: { objectId: '21' } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('location.origin')) return { result: { value: 'https://evil.test' } }
  })
  expect(await execute('login', { credential: { username: 'me', password: 'hunter2', origin: 'https://example.test' } })).toMatchObject({ error: 'browser-login-origin-mismatch' })
})

it('refuses a saved login once the page left the origin it was chosen for', async () => {
  const { execute } = await setupGuest(async (method, params) => {
    if (method === 'Runtime.evaluate' && String(params.expression).includes("querySelectorAll('input[type=password]')")) return { result: { objectId: '21' } }
    if (method === 'Runtime.callFunctionOn' && String(params.functionDeclaration).includes('location.origin')) return { result: { value: 'https://example.test' } }
  })
  expect(await execute('login', { credential: { username: 'me', password: 'hunter2', origin: 'https://bank.test' } })).toMatchObject({ error: 'browser-login-origin-mismatch' })
  expect(await execute('login', { credential: { username: 'me', password: 'hunter2' } })).toMatchObject({ error: 'browser-login-credential-required' })
})

it('keeps console messages and requests for the log commands', async () => {
  const { execute, events } = await setupGuest()
  events.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'boom' }, { type: 'number', value: 2 }] })
  events.emit('message', {}, 'Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }] })
  events.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'r1', type: 'Fetch', request: { url: 'https://example.test/api', method: 'POST' } })
  events.emit('message', {}, 'Network.responseReceived', { requestId: 'r1', response: { status: 500 } })
  events.emit('message', {}, 'Network.loadingFinished', { requestId: 'r1' })
  events.emit('message', {}, 'Network.requestWillBeSent', { requestId: 'r2', type: 'Script', request: { url: 'https://example.test/app.js', method: 'GET' } })
  expect(await execute('console', { level: 'error' })).toMatchObject({ result: { entries: [{ level: 'error', text: 'boom 2' }], total: 1 } })
  expect(await execute('network', { failed: true })).toMatchObject({ result: { entries: [{ url: 'https://example.test/api', method: 'POST', status: 500, type: 'Fetch' }], total: 1 } })
  expect(await execute('network', { clear: true })).toMatchObject({ result: { total: 2 } })
  expect(await execute('network')).toMatchObject({ result: { entries: [], total: 0 } })
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
    if (method === 'DOM.getContentQuads') throw new Error('Node has been removed')
  })
  const observation = await observe()
  expect(await execute('setValue', { observationId: observation.observationId, target: observation.elements[0].id, value: 'text' }))
    .toMatchObject({ result: { action: { status: 'verified' } } })
})

it('types the US-layout shifted character for Shift with a digit or symbol', async () => {
  const { observe, execute, contents } = await setupGuest()
  const observation = await observe()
  const chars = () => contents.sendInputEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'char')
  await execute('pressKey', { key: 'Shift+1', observationId: observation.observationId })
  expect(chars().at(-1)).toEqual({ type: 'char', keyCode: '!', modifiers: ['shift'] })
  await execute('pressKey', { key: 'Shift+-', observationId: observation.observationId })
  expect(chars().at(-1)).toEqual({ type: 'char', keyCode: '_', modifiers: ['shift'] })
})

it('sends keys to its own guest, marked as agent input, never as CDP key events', async () => {
  const { observe, execute, contents } = await setupGuest()
  const observation = await observe()
  const marked: boolean[] = []
  contents.sendInputEvent.mockImplementation(() => { marked.push(isAgentKeyInput(contents as never)) })
  await execute('pressKey', { key: 'Enter', observationId: observation.observationId })
  expect(contents.sendInputEvent.mock.calls.map(([event]) => event.type)).toEqual(['keyDown', 'char', 'keyUp'])
  expect(marked).toEqual([true, true, true])
  expect(isAgentKeyInput(contents as never)).toBe(false)
  expect(contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Input.dispatchKeyEvent')).toBe(false)
})

it('lets a call without ids or points follow the page past a stale observation', async () => {
  const { observe, execute, events } = await setupGuest()
  const before = await observe()
  events.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'new' } })
  expect(await execute('pressKey', { key: 'Escape', observationId: before.observationId })).toMatchObject({ result: { action: { method: 'pressKey' } } })
  expect(await execute('click', { target: before.elements[0].id, observationId: before.observationId })).toMatchObject({ error: 'stale-browser-observation' })
})

it('returns from an action a dialog interrupts, refuses other calls until it is answered, and answers it', async () => {
  const dialogs = new GuestDialogs()
  let answered: unknown
  const guest = { id: 80, isDestroyed: () => false, hostWebContents: null, on: vi.fn(), once: vi.fn(), removeListener: vi.fn() }
  let releaseClick!: () => void
  const { observe, execute } = await setupGuest(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
      // The page's click handler calls confirm(): the page blocks until it is answered.
      dialogs.open(guest as never, { type: 'confirm', message: 'Delete it?' }, (value) => { answered = value; releaseClick() })
      await new Promise<void>(resolve => { releaseClick = resolve })
      return {}
    }
  }, { dialogs })
  const observation = await observe()
  const clicked = await execute('click', { target: observation.elements[0].id, observationId: observation.observationId })
  expect(clicked).toMatchObject({ dialog: { type: 'confirm', message: 'Delete it?' }, result: { action: { method: 'click', status: 'dispatched' } } })
  expect(String((clicked.result as { action: { notices: string[] } }).action.notices[0])).toContain('cate browser dialog accept')
  expect(await execute('getAXState')).toMatchObject({ error: 'browser-dialog-open' })
  const result = await execute('dialog', { action: 'accept' })
  expect(answered).toBe(true)
  expect(result).toMatchObject({ result: { action: { method: 'dialog', status: 'verified' }, observation: { kind: 'ax' } } })
  expect(await execute('dialog', { action: 'dismiss' })).toMatchObject({ error: 'browser-no-dialog' })
})
