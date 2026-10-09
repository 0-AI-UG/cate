import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { clientStateFor, documentStoreFor } from '@client/document'
import { MAIN_WINDOW, createDocument, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { addRelation, beginPanelInteraction, clearPanelInteractions } from '../../../workspace/relations'
import { openTestDocument, testRelationHost } from './testing'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { createCanvasView, type CanvasViewStore } from './store'
import { installCanvasDrag, type CanvasDragState } from './ports'
import { CanvasRelationOverlayContext, CanvasViewProvider } from './context'
import { PanelConnectionLayer } from './PanelConnectionLayer'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const WS = 'ws-connections'
let container: HTMLDivElement
let root: Root
let detach: () => void
let store: CanvasViewStore | null = null

const panel = (id: string, type: PanelRecord['type'], fields: PanelRecord['fields'] = {}): PanelRecord =>
  ({ id, type, title: id[0].toUpperCase() + id.slice(1), fields })

function docWith(panels: PanelRecord[], nodes: WorkspaceDocument['canvases'][string]['nodes'], relations: WorkspaceDocument['relations'] = {}): WorkspaceDocument {
  const doc = createDocument()
  const canvas: PanelRecord = { id: 'canvas', type: 'canvas', title: 'Canvas', canvasId: 'c', fields: {} }
  return {
    ...doc,
    panels: Object.fromEntries([canvas, ...panels].map((p) => [p.id, p])),
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: { kind: 'stack', id: 'main', panels: ['canvas'] } } },
    canvases: { c: { id: 'c', nodes } },
    relations,
  }
}

function standardDocument(): WorkspaceDocument {
  return docWith(
    [
      panel('agent', 'chat'),
      panel('worker', 'terminal'),
      panel('browser', 'browser'),
    ],
    {
      source: { id: 'source', rect: { origin: { x: 0, y: 0 }, size: { width: 200, height: 120 } }, dock: { kind: 'stack', id: 'source-tabs', panels: ['agent'] } },
      target: { id: 'target', rect: { origin: { x: 400, y: 0 }, size: { width: 200, height: 120 } }, dock: { kind: 'stack', id: 'target-tabs', panels: ['worker', 'browser'] } },
    },
  )
}

let settings: ReturnType<typeof testRelationHost>

function open(doc: WorkspaceDocument, browserActive = true): CanvasViewStore {
  detach = openTestDocument(WS, doc)
  if (browserActive) clientStateFor(WS)!.setActiveTab('target-tabs', 'browser')
  store = createCanvasView({ workspaceId: WS, canvasId: 'c', document: documentStoreFor(WS)!, clientState: clientStateFor(WS), animate: false })
  return store
}

function render(view: CanvasViewStore, overlay?: HTMLElement) {
  const layer = <CanvasViewProvider store={view}><PanelConnectionLayer workspaceId={WS} /></CanvasViewProvider>
  act(() => root.render(overlay
    ? <CanvasRelationOverlayContext.Provider value={overlay}>{layer}</CanvasRelationOverlayContext.Provider>
    : layer))
}

const relations = () => Object.values(documentStoreFor(WS)!.getSnapshot().relations)

beforeEach(() => {
  settings = testRelationHost({ definitions: [...PANEL_DEFINITIONS] })
  clearPanelInteractions()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  clearPanelInteractions()
  installCanvasDrag(null)
  settings.uninstall()
  store?.getState().dispose()
  store = null
  detach()
})

describe('PanelConnectionLayer', () => {
  it('overlays resolved CLI activity as a directed path', () => {
    render(open(standardDocument()))
    act(() => { beginPanelInteraction({ workspaceId: WS, sourcePanelId: 'agent', targetPanelId: 'browser', kind: 'control' }) })
    const path = container.querySelector('[data-panel-connection="active"]')
    expect(path).not.toBeNull()
    expect(path?.getAttribute('marker-end')).toContain('active')
  })

  it('renders a user-declared relation with a horizontal meaning selector', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const path = container.querySelector('[data-panel-connection="relation"]')
    expect(path).not.toBeNull()
    expect(path?.classList.contains('cate-panel-connection')).toBe(true)
    expect(path?.classList.contains('cate-panel-connection-active')).toBe(false)
    const selector = container.querySelector('[data-panel-relation-selector]')
    expect(selector?.classList.contains('z-[500]')).toBe(true)
    expect(container.textContent).toContain('Work in')
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.click())
    expect(container.querySelectorAll('[role="menuitemradio"]')).toHaveLength(3)
    expect([...container.querySelectorAll('[role="menuitemradio"]')]
      .filter((item) => item.textContent?.includes('Recommended'))).toHaveLength(1)
  })

  it('labels a browser-to-execution relation as sending findings', () => {
    const view = open(standardDocument())
    addRelation(WS, 'browser', 'agent', 'context')
    render(view)
    expect(container.querySelector('[data-panel-relation-chip]')?.textContent).toContain('Send findings to')
    expect(container.querySelector('[data-panel-relation-chip]')?.textContent).not.toContain('Hand off')
  })

  it('moves connections with the drag ghost and hides them away from the canvas', () => {
    let state: CanvasDragState = { dragging: false, sourceNodeId: null }
    const listeners = new Set<() => void>()
    const setDrag = (next: CanvasDragState) => { state = next; for (const l of [...listeners]) l() }
    installCanvasDrag({
      getState: () => state,
      subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l) } },
      beginNodeDrag: () => {},
      beginTabDrag: () => {},
      wasDragged: () => false,
    })
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const initialPath = container.querySelector('[data-panel-connection="relation"]')?.getAttribute('d')

    act(() => setDrag({ dragging: true, sourceNodeId: 'source', ghostOrigin: { x: 120, y: 180 } }))
    expect(container.querySelector('[data-panel-connection="relation"]')?.getAttribute('d')).not.toBe(initialPath)

    act(() => setDrag({ dragging: true, sourceNodeId: 'source', ghostOrigin: null }))
    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()

    act(() => setDrag({ dragging: true, sourceNodeId: 'source', ghostOrigin: { x: 160, y: 220 } }))
    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
  })

  it('hides user relations while preserving agent activity connections when disabled', () => {
    const view = open(standardDocument(), false)
    addRelation(WS, 'agent', 'worker', 'trigger')
    settings.setEnabled(false)
    render(view)
    act(() => { beginPanelInteraction({ workspaceId: WS, sourcePanelId: 'agent', targetPanelId: 'worker', kind: 'agent' }) })
    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).toBeNull()
    expect(container.querySelector('[data-panel-connection="active"]')).not.toBeNull()
  })

  it('starts a different-colored flow at every terminal or T3 panel', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const types = { a: 'terminal', b: 'browser', c: 'chat', d: 'terminal', e: 'editor' } as const
    const doc = docWith(
      ids.map((id) => panel(id, types[id as keyof typeof types])),
      Object.fromEntries(ids.map((id, index) => [id, {
        id,
        rect: { origin: { x: index * 240, y: index < 3 ? 0 : 240 }, size: { width: 180, height: 100 } },
        dock: { kind: 'stack' as const, id: `${id}-tabs`, panels: [id] },
      }])),
      {
        'flow-one-a': { id: 'flow-one-a', fromPanelId: 'a', toPanelId: 'b', kind: 'use' },
        'flow-one-b': { id: 'flow-one-b', fromPanelId: 'b', toPanelId: 'c', kind: 'context' },
        'flow-two-a': { id: 'flow-two-a', fromPanelId: 'c', toPanelId: 'e', kind: 'context' },
        'flow-three': { id: 'flow-three', fromPanelId: 'd', toPanelId: 'b', kind: 'use' },
      },
    )
    render(open(doc, false))
    const first = container.querySelector('[data-panel-relation-id="flow-one-a"]')!
    const handoff = container.querySelector('[data-panel-relation-id="flow-one-b"]')!
    const receiverFlow = container.querySelector('[data-panel-relation-id="flow-two-a"]')!
    const otherSenderFlow = container.querySelector('[data-panel-relation-id="flow-three"]')!
    expect(first.getAttribute('stroke')).toBe(handoff.getAttribute('stroke'))
    expect(first.getAttribute('marker-end')).toBe(handoff.getAttribute('marker-end'))
    expect(receiverFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(receiverFlow.getAttribute('marker-end')).not.toBe(first.getAttribute('marker-end'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(receiverFlow.getAttribute('stroke'))
  })

  it('portals only the relation menu above persistent browser surfaces', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    const overlay = document.createElement('div')
    document.body.appendChild(overlay)
    render(view, overlay)
    expect(container.querySelector('[data-panel-relation-chip]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Connection meaning"]')).toBeNull()
    expect(overlay.querySelector('[aria-label="Connection meaning"]')).not.toBeNull()
    expect(overlay.querySelector('[data-panel-relation-chip]')).toBeNull()
    act(() => root.render(<div />))
    overlay.remove()
  })

  it('drags the relationship chip as a zoom-aware point on the curve, sending one op', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    act(() => view.getState().setZoom(2))
    render(view)
    const propose = vi.spyOn(documentStoreFor(WS)!, 'propose')
    const chip = container.querySelector<HTMLElement>('[data-panel-relation-chip]')!
    act(() => chip.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 600, clientY: 120 })))
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 620, clientY: 130 })))
    act(() => window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 640, clientY: 140 })))
    expect(propose).not.toHaveBeenCalled()
    expect(container.querySelector<HTMLElement>('[data-panel-relation-selector]')!.style.left).toBe('320px')
    act(() => window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true })))
    expect(propose).toHaveBeenCalledTimes(1)
    expect(relations()[0].waypoint).toEqual({ x: 320, y: 70 })
    expect(container.querySelector<HTMLElement>('[data-panel-relation-selector]')!.style.left).toBe('320px')
  })

  it('removes a connection from the persistent selector', () => {
    const view = open(standardDocument())
    const relationId = addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const remove = container.querySelector(`[data-panel-connection-delete="${relationId}"]`)
    expect(remove).not.toBeNull()
    act(() => remove!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(relations()).toEqual([])
  })

  it('adds a custom relationship from the menu', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const add = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((button) => button.textContent?.includes('Add custom relationship'))!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[data-panel-relation-custom-input]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'summarizes for')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.textContent).toContain('summarizes for')
    expect(settings.labels()).toEqual(['summarizes for'])
  })

  it('edits, reuses, and deletes saved relationship labels inline', () => {
    settings.setLabels(['summarizes for', 'checks with'])
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    const canvasMouseDown = vi.fn()
    act(() => root.render(
      <div onMouseDown={canvasMouseDown}>
        <CanvasViewProvider store={view}><PanelConnectionLayer workspaceId={WS} /></CanvasViewProvider>
      </div>,
    ))
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('Saved relationships')
    const edit = container.querySelector<HTMLButtonElement>('[aria-label="Edit saved relationship summarizes for"]')!
    expect(edit.nextElementSibling?.getAttribute('aria-label')).toBe('Delete saved relationship summarizes for')
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = container.querySelector<HTMLInputElement>('[aria-label="Edit saved relationship summarizes for"]')!
    act(() => input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 })))
    expect(canvasMouseDown).not.toHaveBeenCalled()
    expect(input.classList.contains('select-text')).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reports to')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(settings.labels()).toEqual(['reports to', 'checks with'])

    const reuse = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((button) => button.textContent?.includes('reports to'))!
    act(() => reuse.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('reports to')

    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Delete saved relationship reports to"]')!
    act(() => remove.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(settings.labels()).toEqual(['checks with'])
    expect(relations()[0].label).toBe('reports to')
    expect(container.textContent).toContain('reports to')
  })

  it('renders relations only while both addressed panels are visible', () => {
    const view = open(standardDocument(), false)
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).toBeNull()
    act(() => clientStateFor(WS)!.setActiveTab('target-tabs', 'browser'))
    expect(container.querySelector('[data-panel-connection="relation"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).not.toBeNull()
  })

  it('animates the existing relation path while that panel pair is active', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const idlePath = container.querySelector('[data-panel-connection="relation"]')
    act(() => { beginPanelInteraction({ workspaceId: WS, sourcePanelId: 'agent', targetPanelId: 'browser', kind: 'control' }) })
    const activePath = container.querySelector('[data-panel-connection="active"]')
    expect(activePath).toBe(idlePath)
    expect(activePath?.classList.contains('cate-panel-connection-active')).toBe(true)
    expect(container.querySelectorAll('path[data-panel-connection]')).toHaveLength(1)
  })
})
