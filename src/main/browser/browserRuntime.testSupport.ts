import { EventEmitter } from 'events'
import { vi } from 'vitest'
import { BrowserRuntimeRegistry } from './browserRuntime'
import type { BrowserObservation } from '../../shared/browserAutomation'

export const identity = { workspaceId: 'workspace', panelId: 'browser', tabId: 'tab' }
export async function setupGuest(hook?: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>) {
  const events = new EventEmitter()
  const state = {
    nodes: [{ nodeId: 'button', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Save' } }] as Record<string, unknown>[],
    viewport: { width: 800, height: 600, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 },
    checked: false, text: 'Busy', value: '',
  }
  const png = Buffer.alloc(24); png.writeUInt32BE(800, 16); png.writeUInt32BE(600, 20)
  const nativeImage = { toPNG: () => png, resize: vi.fn() }; nativeImage.resize.mockReturnValue(nativeImage)
  const contents = {
    id: 80, once: vi.fn(), isDestroyed: () => false, getURL: () => 'https://example.test/', getTitle: () => 'Example', getZoomFactor: () => 1,
    send: vi.fn(), capturePage: vi.fn(async () => nativeImage),
    debugger: { isAttached: () => true, on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        const result = await hook?.(method, params, sessionId)
        if (result !== undefined) return result
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression).includes('const promise=new Promise')) return { result: { objectId: 'wheel-watch' } }
          if (String(params.expression).includes('devicePixelRatio')) return { result: { value: { ...state.viewport } } }
          if (params.expression === 'document.activeElement') return { result: { objectId: 'active' } }
          return { result: { value: state.text } }
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: state.nodes }
        if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: 7, attributes: [] } }
        if (method === 'DOM.getBoxModel') return { model: { content: [20, 20, 120, 20, 120, 60, 20, 60] } }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration)
          if (fn.includes('password: this instanceof HTMLInputElement')) return { result: { value: { visible: true, offscreen: false, password: false } } }
          if (fn.includes('typeof this.checked') || fn.includes('Boolean(this.checked);')) return { result: { value: state.checked } }
          if (fn.includes('return { visible:this.isConnected')) return { result: { value: { visible: true, enabled: true, checked: state.checked } } }
          return { result: { value: true } }
        }
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') state.checked = !state.checked
        return {}
      }),
    },
  }
  const runtime = new BrowserRuntimeRegistry()
  await runtime.attach(contents as never, identity)
  const execute = (method: string, args: Record<string, unknown> = {}) => runtime.execute(contents.id, identity, method, args)
  const observe = async (args: Record<string, unknown> = {}) => (await execute('getAXState', args)).result as BrowserObservation
  return { runtime, contents, events, state, png, nativeImage, execute, observe }
}
