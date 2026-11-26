import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { clientStateFor, documentStoreFor } from '@client/document'
import { MAIN_WINDOW, createDocument, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import { addRelation } from '../../../workspace/relations'
import { openTestDocument, testRelationHost } from './testing'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { createCanvasView, type CanvasViewStore } from './store'
import { installCanvasDrag, type CanvasDragState } from './ports'
import { CanvasRelationOverlayContext, CanvasViewProvider } from './context'
import { PanelConnectionLayer } from './PanelConnectionLayer'
import type { AgentPanelStates } from '@services/agents/contract'

let agentStates: AgentPanelStates = {}
vi.mock('../../../services/agents', () => ({
  useAgentPanels: (_workspaceId: string, select: (states: AgentPanelStates) => unknown) => select(agentStates),
}))

function setPending(pending: boolean) {
  agentStates = { agent: { panelId: 'agent', agentId: 'claude-code', agentName: 'Claude', label: 'Claude',
    contextPolicy: 'supported', contextPending: pending, present: true, canReceivePrompt: true,
    session: null, status: 'waitingForInput' } }
}

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
      panel('agent', 'terminal'),
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

function open(doc: WorkspaceDocument, browserActive = true, selected: string[] = ['source']): CanvasViewStore {
  detach = openTestDocument(WS, doc)
  if (browserActive) clientStateFor(WS)!.setActiveTab('target-tabs', 'browser')
  store = createCanvasView({ workspaceId: WS, canvasId: 'c', document: documentStoreFor(WS)!, clientState: clientStateFor(WS), animate: false })
  store.setState({ selection: selected })
  return store
}

function render(view: CanvasViewStore, overlay?: HTMLElement) {
  const layer = <CanvasViewProvider store={view}><PanelConnectionLayer workspaceId={WS} /></CanvasViewProvider>
  act(() => root.render(overlay
    ? <CanvasRelationOverlayContext.Provider value={overlay}>{layer}</CanvasRelationOverlayContext.Provider>
    : layer))
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!

const relations = () => Object.values(documentStoreFor(WS)!.getSnapshot().relations)

beforeEach(() => {
  setPending(true)
  settings = testRelationHost({ definitions: [...PANEL_DEFINITIONS] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  installCanvasDrag(null)
  settings.uninstall()
  store?.getState().dispose()
  store = null
  detach()
})

describe('PanelConnectionLayer', () => {
  it('draws only declared relations', () => {
    render(open(standardDocument()))
    expect(container.querySelector('[data-panel-connection]')).toBeNull()
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
    expect(dialog().querySelectorAll('[role="radio"]')).toHaveLength(3)
    expect([...dialog().querySelectorAll('[role="radio"]')]
      .filter((item) => item.textContent?.includes('Recommended'))).toHaveLength(1)
  })

  it('dims the whole flow when the runtime has no context pending for its next turn', () => {
    const doc = standardDocument()
    setPending(false)
    const view = open(doc, false)
    addRelation(WS, 'agent', 'worker', 'trigger')
    render(view)
    const path = () => container.querySelector('[data-panel-connection="relation"]')
    expect(path()?.getAttribute('data-panel-relation-context-pending')).toBe('false')
    expect(path()?.parentElement?.getAttribute('opacity')).toBe('0.85')
    expect(path()?.classList.contains('cate-panel-connection-pending')).toBe(false)
    expect(container.querySelector('[data-panel-relation-chip]')?.classList.contains('opacity-70')).toBe(true)

    setPending(true)
    render(view)
    expect(path()?.getAttribute('data-panel-relation-context-pending')).toBe('true')
    expect(path()?.parentElement?.getAttribute('opacity')).toBe('1')
    expect(path()?.classList.contains('cate-panel-connection-pending')).toBe(true)
    expect(container.querySelector('[data-panel-relation-chip]')?.classList.contains('opacity-70')).toBe(false)
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

  it('hides relations when disabled', () => {
    const view = open(standardDocument(), false)
    addRelation(WS, 'agent', 'worker', 'trigger')
    settings.setEnabled(false)
    render(view)
    expect(container.querySelector('[data-panel-connection="relation"]')).toBeNull()
    expect(container.querySelector('[data-panel-relation-selector]')).toBeNull()
    expect(container.querySelector('[data-panel-connection]')).toBeNull()
  })

  it('starts a different-colored flow at every terminal panel', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const types = { a: 'terminal', b: 'browser', c: 'terminal', d: 'terminal', e: 'editor' } as const
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
    render(open(doc, false, ids))
    const arrow = (id: string) => container.querySelector(`[data-panel-connection-arrow="${id}"]`)!
    const first = container.querySelector('[data-panel-relation-id="flow-one-a"]')!
    const handoff = container.querySelector('[data-panel-relation-id="flow-one-b"]')!
    const receiverFlow = container.querySelector('[data-panel-relation-id="flow-two-a"]')!
    const otherSenderFlow = container.querySelector('[data-panel-relation-id="flow-three"]')!
    expect(first.getAttribute('stroke')).toBe(handoff.getAttribute('stroke'))
    expect(arrow('flow-one-a').getAttribute('fill')).toBe(arrow('flow-one-b').getAttribute('fill'))
    expect(receiverFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(arrow('flow-two-a').getAttribute('fill')).not.toBe(arrow('flow-one-a').getAttribute('fill'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(first.getAttribute('stroke'))
    expect(otherSenderFlow.getAttribute('stroke')).not.toBe(receiverFlow.getAttribute('stroke'))
  })

  it('names a connection while a panel it joins is selected; otherwise its line is the click target', () => {
    const view = open(standardDocument(), true, [])
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const path = container.querySelector('[data-panel-connection="relation"]')!
    expect(container.querySelector('[data-panel-relation-chip]')).toBeNull()
    expect(path.parentElement?.getAttribute('opacity')).toBe('0.75')
    act(() => container.querySelector<HTMLElement>('[data-panel-connection-hit]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(dialog()).not.toBeNull()
    act(() => dialog().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    act(() => view.setState({ selection: ['target'] }))
    expect(container.querySelector('[data-panel-relation-chip]')).not.toBeNull()
    expect(path.parentElement?.getAttribute('opacity')).toBe('1')
  })

  it('draws idle lines neutral and outlines the panel a lit connection reaches', () => {
    const view = open(standardDocument(), true, [])
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    expect(container.querySelector('[data-panel-connection="relation"]')!.getAttribute('stroke')).toBe('var(--text-muted)')
    expect(container.querySelector('[data-panel-connection-outline]')).toBeNull()
    act(() => view.setState({ selection: ['source'] }))
    expect(container.querySelector('[data-panel-connection="relation"]')!.getAttribute('stroke')).not.toBe('var(--text-muted)')
    expect(container.querySelector('[data-panel-connection-outline="target"]')).not.toBeNull()
    expect(container.querySelector('[data-panel-connection-outline="source"]')).toBeNull()
  })

  it('opens the meaning as a dialog, not a dropdown', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.click())
    expect(container.querySelector('[role="dialog"]')).toBeNull()
    expect(dialog().getAttribute('aria-label')).toBe('Connection')
  })

  it('picks a meaning with a number key and moves between rows with arrows', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.click())
    const rows = () => [...dialog().querySelectorAll<HTMLElement>('[data-list-row]')]
    rows()[0].focus()
    act(() => { rows()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    expect(document.activeElement).toBe(rows()[1])
    act(() => { rows()[1].dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true })) })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(relations()[0].kind).not.toBe('use')
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

  it('removes a connection from its dialog', () => {
    const view = open(standardDocument())
    const relationId = addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.click())
    const remove = dialog().querySelector(`[data-panel-connection-delete="${relationId}"]`)
    expect(remove).not.toBeNull()
    act(() => remove!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(relations()).toEqual([])
  })

  it('adds a custom relationship from the menu', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const add = [...dialog().querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('Add custom relationship'))!
    act(() => add.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = dialog().querySelector<HTMLInputElement>('[data-panel-relation-custom-input]')!
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
    expect(dialog().textContent).toContain('Saved relationships')
    const edit = dialog().querySelector<HTMLButtonElement>('[aria-label="Edit saved relationship summarizes for"]')!
    expect(edit.nextElementSibling?.getAttribute('aria-label')).toBe('Delete saved relationship summarizes for')
    act(() => edit.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const input = dialog().querySelector<HTMLInputElement>('[aria-label="Edit saved relationship summarizes for"]')!
    act(() => input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 10 })))
    expect(canvasMouseDown).not.toHaveBeenCalled()
    expect(input.classList.contains('select-text')).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'reports to')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(settings.labels()).toEqual(['reports to', 'checks with'])

    const reuse = [...dialog().querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((button) => button.textContent?.includes('reports to'))!
    act(() => reuse.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('reports to')

    act(() => container.querySelector<HTMLElement>('[data-panel-relation-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    const remove = dialog().querySelector<HTMLButtonElement>('[aria-label="Delete saved relationship reports to"]')!
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

  it('uses only pending context, regardless of command activity or outcome', () => {
    const view = open(standardDocument())
    addRelation(WS, 'agent', 'browser', 'use')
    render(view)
    const path = () => container.querySelector('[data-panel-connection="relation"]')!
    const color = path().getAttribute('stroke')
    expect(path().parentElement?.getAttribute('opacity')).toBe('1')
    setPending(false)
    render(view)
    expect(path().parentElement?.getAttribute('opacity')).toBe('0.85')
    expect(path().getAttribute('stroke')).toBe(color)
    expect(path().getAttribute('class')).toBe('cate-panel-connection')
    expect(container.querySelectorAll('path[data-panel-connection]')).toHaveLength(1)
  })
})
