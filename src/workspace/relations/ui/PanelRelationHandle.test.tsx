import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clientStateFor, documentStoreFor } from '@client/document'
import { createCanvasView, type CanvasViewStore } from '@client/layout/canvas/store'
import { openTestDocument, testRelationHost } from '@client/layout/canvas/testing'
import { panelConnectionAnchor } from '../contract'
import { MAIN_WINDOW, createDocument, type PanelRecord, type PanelType, type WorkspaceDocument } from '@workspace/document/contract'
import { RelationCanvasProvider, type RelationPanelKind } from './host'
import { PanelRelationHandle } from './PanelRelationHandle'
import { installRelationUiHost } from './host'
import { installRelationUiPort } from './port'
import { useRelationUi } from './state'
import { panelDefinition } from '@panels/definitions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const definition = (type: PanelType, label: string, width: number, height: number, splitMenuOrder: number, canLiveOnCanvas = true) =>
  ({ type, label, icon: 'grid', defaultSize: { width, height }, canLiveOnCanvas, splitMenuOrder, relation: panelDefinition(type)?.relation }) satisfies RelationPanelKind

const DEFINITIONS = [
  definition('editor', 'Files', 600, 500, 0),
  definition('terminal', 'Terminal', 640, 400, 1),
  definition('browser', 'Browser', 800, 600, 2),
  definition('canvas', 'Canvas', 800, 600, 3, false),
]

let container: HTMLDivElement
let root: Root
let detach: (() => void) | null = null
let view: CanvasViewStore | null = null

function openDocument(panels: PanelRecord[], nodes: WorkspaceDocument['canvases'][string]['nodes'] = {}): void {
  const canvas: PanelRecord = { id: 'canvas', type: 'canvas', title: 'Canvas', canvasId: 'c', fields: {} }
  detach = openTestDocument('ws', {
    ...createDocument(),
    panels: Object.fromEntries([canvas, ...panels].map((p) => [p.id, p])),
    windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: { kind: 'stack', id: 'main', panels: ['canvas'] } } },
    canvases: { c: { id: 'c', nodes } },
  })
}

const rect = (left: number, top: number, width: number, height: number) => () => ({
  left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}),
}) as DOMRect

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  testRelationHost({
    definitions: DEFINITIONS,
    createPanel: (workspaceId, type, { at }) => {
      const id = `${type}-new`
      const result = documentStoreFor(workspaceId)!.propose({
        kind: 'addPanel',
        record: { id, type: type as PanelType, title: type, fields: {} },
        at,
      })
      return result.ok ? id : null
    },
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelector('[data-test-target]')?.remove()
  view?.getState().dispose()
  view = null
  detach?.()
  detach = null
  installRelationUiHost(null)
  installRelationUiPort(null)
  useRelationUi.getState().openRelationEditor(null)
})

describe('PanelRelationHandle', () => {
  it('renders one outside connection point on every side', () => {
    act(() => root.render(<PanelRelationHandle workspaceId="ws" sourcePanelId="source" />))
    const handles = [...container.querySelectorAll('[data-panel-connection-handle]')]
    expect(handles.map((handle) => handle.getAttribute('data-panel-connection-handle'))).toEqual(['top', 'right', 'bottom', 'left'])
    expect(handles.every((handle) => handle.classList.contains('h-5') && handle.classList.contains('w-5'))).toBe(true)
    expect(handles.every((handle) => handle.querySelector('.h-2.w-2.bg-focus-blue'))).toBe(true)
  })

  it('snaps to a browser port without relying on webview pointer events', async () => {
    openDocument([
      { id: 'source', type: 'terminal', title: 'Terminal', fields: {} },
      { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
    ])
    const showMenu = vi.fn(async () => null)
    installRelationUiPort({ showMenu })
    const target = document.createElement('div')
    target.dataset.testTarget = 'true'
    target.dataset.nodeId = 'browser-node'
    target.dataset.activePanelId = 'browser'
    target.getBoundingClientRect = rect(300, 100, 400, 400)
    document.body.appendChild(target)

    act(() => root.render(<PanelRelationHandle workspaceId="ws" sourcePanelId="source" />))
    const source = container.querySelector<HTMLElement>('[data-panel-connection-handle="right"]')!
    source.getBoundingClientRect = rect(180, 292, 16, 16)
    act(() => source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 188, clientY: 300 })))
    const overlay = document.body.querySelector<HTMLElement>('.cursor-crosshair')!
    act(() => overlay.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 288, clientY: 300 })))
    expect(document.body.querySelectorAll('[data-panel-connection-target]')).toHaveLength(4)
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 288, clientY: 300 }))
    })

    const relations = Object.values(documentStoreFor('ws')!.getSnapshot().relations)
    expect(relations).toEqual([
      expect.objectContaining({ fromPanelId: 'source', toPanelId: 'browser', kind: 'use', fromSide: 'right', toSide: 'left' }),
    ])
    expect(showMenu).not.toHaveBeenCalled()
    expect(useRelationUi.getState().editingRelationId).toBe(relations[0].id)
  })

  it('opens the panel picker in the relation portal and links the created panel', async () => {
    openDocument(
      [{ id: 'source', type: 'terminal', title: 'Terminal', fields: {} }],
      { sourceNode: { id: 'sourceNode', rect: { origin: { x: 0, y: 0 }, size: { width: 100, height: 100 } }, dock: { kind: 'stack', id: 's', panels: ['source'] } } },
    )
    view = createCanvasView({ workspaceId: 'ws', canvasId: 'c', document: documentStoreFor('ws')!, clientState: clientStateFor('ws'), animate: false })
    view.setState({ zoomLevel: 2, viewportOffset: { x: 20, y: 40 }, containerSize: { width: 800, height: 600 } })
    const canvas = document.createElement('div')
    canvas.dataset.canvasContainer = ''
    canvas.dataset.canvasPanelId = 'canvas'
    canvas.getBoundingClientRect = rect(100, 50, 1200, 600)
    const relationPortal = document.createElement('div')
    Object.defineProperty(relationPortal, 'offsetWidth', { configurable: true, value: 1 })
    canvas.appendChild(container)
    document.body.append(canvas, relationPortal)

    act(() => root.render(
      <RelationCanvasProvider canvas={view!} overlayTarget={relationPortal}>
        <PanelRelationHandle workspaceId="ws" sourcePanelId="source" />
      </RelationCanvasProvider>,
    ))
    const source = container.querySelector<HTMLElement>('[data-panel-connection-handle="right"]')!
    source.getBoundingClientRect = rect(180, 292, 16, 16)
    act(() => source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })))
    const overlay = document.body.querySelector<HTMLElement>('.cursor-crosshair')!
    await act(async () => {
      overlay.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 1000, clientY: 350 }))
    })

    expect(container.querySelector('[aria-label="New linked panel"]')).toBeNull()
    const menu = relationPortal.querySelector<HTMLElement>('[aria-label="New linked panel"]')!
    expect(menu).not.toBeNull()
    expect(menu.querySelector('[data-panel-connection-menu-port]')).not.toBeNull()
    const preview = relationPortal.querySelector<SVGPathElement>('[data-panel-connection-create-preview] path')!
    expect(preview.getAttribute('d')).toMatch(/^M 34 105 C /)
    expect(preview.getAttribute('d')).toMatch(/, 440 130$/)
    expect(preview.getAttribute('stroke-dasharray')).toBe('6 5')
    expect(menu.style.top).toBe('130px')
    expect(menu.style.right).toBe('-671px')
    expect(menu.style.transform).toBe('translateY(-50%)')
    expect(menu.style.animation).toBe('none')
    const labels = [...menu.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
    expect(labels).toEqual(['Files', 'Terminal', 'Browser'])

    await act(async () => {
      ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((item) => item.textContent === 'Browser')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const doc = documentStoreFor('ws')!.getSnapshot()
    const relations = Object.values(doc.relations)
    expect(relations).toEqual([
      expect.objectContaining({ fromPanelId: 'source', toPanelId: 'browser-new', kind: 'use', fromSide: 'right', toSide: 'left' }),
    ])
    const browserNodeId = view.getState().nodeForPanel('browser-new')!
    const browserNode = view.getState().nodes[browserNodeId]!
    expect(browserNode.origin).toEqual({ x: 452, y: -170 })
    expect(panelConnectionAnchor(browserNode.rect, relations[0].toSide!)).toEqual({ x: 440, y: 130 })
    expect(view.getState().selection).toEqual([browserNodeId])
    for (const nodeId of ['sourceNode', browserNodeId]) {
      const frame = view.getState().viewFrame(nodeId)!
      expect(frame.origin.x).toBeGreaterThanOrEqual(0)
      expect(frame.origin.y).toBeGreaterThanOrEqual(0)
      expect(frame.origin.x + frame.size.width).toBeLessThanOrEqual(800)
      expect(frame.origin.y + frame.size.height).toBeLessThanOrEqual(600)
    }

    relationPortal.remove()
    canvas.remove()
  })
})
