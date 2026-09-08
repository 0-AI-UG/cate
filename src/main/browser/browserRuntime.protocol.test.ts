import { EventEmitter } from 'events'
import { expect, it, vi } from 'vitest'
vi.mock('electron', () => ({}))
import { BrowserRuntimeRegistry } from './browserRuntime'

it('returns numeric stable IDs, request-scoped diffs and actual image bytes', async () => {
  const events = new EventEmitter()
  const png = Buffer.alloc(24); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20)
  const image = { toPNG: () => png, resize: vi.fn() }; image.resize.mockReturnValue(image)
  const contents = {
    id: 500, once: vi.fn(), isDestroyed: () => false, getURL: () => 'https://example.test', getTitle: () => 'Example', getZoomFactor: () => 1,
    capturePage: vi.fn(async () => image), send: vi.fn(),
    debugger: { isAttached: () => true, on: events.on.bind(events), removeListener: events.removeListener.bind(events), sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
      if (method === 'Runtime.evaluate') return { result: { value: { width: 800, height: 600, zoom: 1, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 } } }
      if (method === 'Accessibility.getFullAXTree') return { nodes: [{ backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Save' } }] }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'save' } }
      if (method === 'Runtime.callFunctionOn') return { result: { value: String(params.functionDeclaration).includes('password: this instanceof HTMLInputElement') ? { visible: true, offscreen: false, password: false } : true } }
      return {}
    }) },
  }
  const identity = { workspaceId: 'w', panelId: 'p', tabId: 't' }
  const runtime = new BrowserRuntimeRegistry(); await runtime.attach(contents as never, identity)
  const first = await runtime.execute(500, identity, 'getAXStateAndScreenshot', {}) as { result: { elements: {id:number}[]; observationId:string; documentId:string; screenshot:{data:string}; state:string; diff:boolean } }
  expect(first.result).toMatchObject({ elements: [{ id: expect.any(Number) }], screenshot: { data: png.toString('base64') }, diff: false })
  const second = await runtime.execute(500, identity, 'getAXState', { observationId: first.result.observationId }) as typeof first
  expect(second.result.elements[0].id).toBe(first.result.elements[0].id)
  expect(second.result.diff).toBe(true)
  expect(second.result.state).toContain('No changes')
  events.emit('message', {}, 'Page.frameNavigated', { frame: { id: 'main' } })
  const stale = await runtime.execute(500, identity, 'click', { observationId: first.result.observationId, target: first.result.elements[0].id })
  expect(stale.error).toBe('stale-browser-observation')
})

it.each(['command', 'readCommand', 'snapshot', 'evaluate', 'fill', 'type', 'press', 'mouse'])('rejects removed method %s', async (method) => {
  const runtime = new BrowserRuntimeRegistry()
  const events = new EventEmitter()
  const contents = { id: 501, once: vi.fn(), isDestroyed: () => false, debugger: { isAttached: () => true, on: events.on.bind(events), removeListener: vi.fn(), sendCommand: vi.fn(async () => ({})) } }
  const identity = { workspaceId: 'w', panelId: 'p', tabId: 't' }; await runtime.attach(contents as never, identity)
  expect(await runtime.execute(501, identity, method, {})).toMatchObject({ error: 'unsupported-browser-method' })
})
