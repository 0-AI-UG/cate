import { EventEmitter } from 'events'
import { vi } from 'vitest'
import { PageDriverRegistry, type PageDriverOptions } from './pageDriver'
import type { BrowserObservation } from '../contract'

export const identity = { panelId: 'browser', tabId: 'tab' }

/** A `DOMSnapshot.captureSnapshot` of one document where every element of
 *  `ids` has a box in an 800x600 viewport, except as `dom` says. */
export function domSnapshot(ids: number[], dom: Record<number, { password?: boolean; offscreen?: boolean; hidden?: boolean }> = {}) {
  const strings = ['INPUT', 'type', 'password', 'text', 'visible', '1', 'main']
  return {
    strings,
    documents: [{
      frameId: 6, scrollOffsetX: 0, scrollOffsetY: 0,
      nodes: {
        parentIndex: ids.map(() => -1), nodeName: ids.map(() => 0), backendNodeId: ids,
        attributes: ids.map(id => [1, dom[id]?.password ? 2 : 3]),
      },
      layout: {
        nodeIndex: ids.flatMap((id, i) => dom[id]?.hidden ? [] : [i]),
        bounds: ids.flatMap(id => dom[id]?.hidden ? [] : [[20, dom[id]?.offscreen ? 5000 : 20, 100, 40]]),
        styles: ids.flatMap(id => dom[id]?.hidden ? [] : [[4, 5]]),
      },
    }],
  }
}

export async function setupGuest(hook?: (method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>, options: PageDriverOptions = {}) {
  const events = new EventEmitter()
  const state = {
    nodes: [{ nodeId: 'button', backendDOMNodeId: 7, role: { value: 'button' }, name: { value: 'Save' } }] as Record<string, unknown>[],
    viewport: { width: 800, height: 600, deviceScaleFactor: 2, scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 600 },
    checked: false, text: 'Busy', value: '',
    dom: {} as Parameters<typeof domSnapshot>[1],
  }
  const nativeImage = { toBitmap: () => Buffer.alloc(4, 255), toJPEG: () => Buffer.alloc(24), getSize: () => ({ width: 800, height: 600 }), resize: vi.fn() }; nativeImage.resize.mockReturnValue(nativeImage)
  const contents = {
    id: 80, once: vi.fn(), isDestroyed: () => false, isLoading: () => false, getURL: () => 'https://example.test/', getTitle: () => 'Example', getZoomFactor: () => 1,
    send: vi.fn(), sendInputEvent: vi.fn(), capturePage: vi.fn(async () => nativeImage), forcefullyCrashRenderer: vi.fn(), reload: vi.fn(),
    debugger: { isAttached: () => true, on: events.on.bind(events), removeListener: events.removeListener.bind(events),
      sendCommand: vi.fn(async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
        const result = await hook?.(method, params, sessionId)
        if (result !== undefined) return result
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
        if (method === 'Runtime.evaluate') {
          if (String(params.expression).includes('const promise=new Promise')) return { result: { objectId: 'wheel-watch' } }
          if (String(params.expression).includes('requestAnimationFrame')) return { result: { value: true } }
          if (String(params.expression).includes('devicePixelRatio')) return { result: { value: { ...state.viewport } } }
          if (params.expression === 'document.activeElement') return { result: { objectId: 'active' } }
          return { result: { value: state.text } }
        }
        if (method === 'Accessibility.getFullAXTree') return { nodes: state.nodes }
        if (method === 'DOMSnapshot.captureSnapshot') return domSnapshot(state.nodes.map(node => Number(node.backendDOMNodeId)), state.dom)
        if (method === 'DOM.resolveNode') return { object: { objectId: String(params.backendNodeId) } }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: /^\d+$/.test(String(params.objectId)) ? Number(params.objectId) : 7, attributes: [] } }
        if (method === 'DOM.getBoxModel') return { model: { content: [20, 20, 120, 20, 120, 60, 20, 60] } }
        if (method === 'Runtime.callFunctionOn') {
          const fn = String(params.functionDeclaration)
          if (fn.includes('this.isContentEditable ? this.innerText : this.value')) return { result: { value: state.value } }
          if (fn.includes("new InputEvent('beforeinput'")) { state.value += JSON.parse(fn.match(/const text=(".*?");/)![1]); return { result: {} } }
          if (fn.includes('element.labels')) return { result: { objectId: String(params.objectId) } }
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
  const runtime = new PageDriverRegistry(options)
  await runtime.attach(contents as never, identity)
  const execute = (method: string, args: Record<string, unknown> = {}) => runtime.execute(contents.id, identity, method, args)
  const observe = async (args: Record<string, unknown> = {}) => (await execute('getAXState', args)).result as BrowserObservation
  return { runtime, contents, events, state, nativeImage, execute, observe }
}
