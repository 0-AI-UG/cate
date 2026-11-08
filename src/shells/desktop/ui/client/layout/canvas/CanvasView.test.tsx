// The canvas view end to end over a real client document store: nodes mount,
// the world transform follows the viewport, and the e2e surface drives it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { rect } from '@workspace/canvas/contract'
import { clientStateFor, documentStoreFor } from '@client/document'
import { resetCanvasViews, setCanvasAnimations } from './registry'
import { canvasDocument } from './testing.canvas'
import { openTestDocument, testRelationHost } from './testing'
import { createCanvasE2E } from './e2e'
import { CanvasView } from './CanvasView'
import { CanvasPanelList } from './CanvasPanelList'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let closeDoc: () => void
let relations: ReturnType<typeof testRelationHost>

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  setCanvasAnimations(false)
  relations = testRelationHost()
  closeDoc = openTestDocument('ws', canvasDocument([
    { nodeId: 'n1', panelId: 'p1', rect: rect(0, 0, 300, 200) },
    { nodeId: 'n2', panelId: 'p2', rect: rect(400, 0, 300, 200) },
  ]))
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => { root = createRoot(container) })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  resetCanvasViews()
  closeDoc()
  relations.uninstall()
  vi.unstubAllGlobals()
})

async function frames(n = 4) {
  for (let i = 0; i < n; i++) await act(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
}

describe('CanvasView', () => {
  it('mounts the nodes and moves the world with the viewport', async () => {
    act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
    await frames()
    expect(container.querySelectorAll('[data-node-id]')).toHaveLength(2)
    const e2e = createCanvasE2E()
    expect(e2e.activeCanvas()).toEqual({ workspaceId: 'ws', canvasId: 'c1', canvasPanelId: 'canvas-panel' })
    act(() => { e2e.setZoom(2); e2e.setViewportOffset({ x: 10, y: 20 }) })
    const world = container.querySelector<HTMLElement>('[data-canvas-world]')!
    expect(world.style.transform).toBe('scale(2) translate(5px, 10px)')
  })

  it('a node offers Move into Dock instead of maximize: its tab goes after the canvas panel', async () => {
    act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
    await frames()
    const node = container.querySelector('[data-node-id="n1"]')!
    expect(node.querySelector('[aria-label="Maximize"]')).toBeNull()
    act(() => node.querySelector<HTMLButtonElement>('[aria-label="Move into Dock"]')!.click())
    await frames()
    const doc = documentStoreFor('ws')!.getSnapshot()
    expect(doc.windows.main.dock).toMatchObject({ kind: 'stack', id: 'main-stack', panels: ['canvas-panel', 'p1'] })
    expect(doc.canvases.c1.nodes.n1).toBeUndefined()
    expect(clientStateFor('ws')!.getSnapshot().focusedPanelId).toBe('p1')
  })

  it('e2e moves and worktree seeding are document ops', async () => {
    act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
    await frames()
    const e2e = createCanvasE2E()
    act(() => e2e.moveNode('n2', { x: 420, y: 40 }))
    await act(async () => {})
    expect(documentStoreFor('ws')!.getSnapshot().canvases.c1.nodes.n2.rect.origin).toEqual({ x: 420, y: 40 })
    const seeded = e2e.seedWorktrees([{ color: 'green' }, { color: 'blue' }])
    expect(seeded).toHaveLength(2)
    expect(e2e.tagNodeWorktree('n2', seeded[1].id)).toBe(true)
    expect(documentStoreFor('ws')!.getSnapshot().panels.p2.worktreeId).toBe(seeded[1].id)
    expect(e2e.worktreeDebug().liveWorktrees).toBe(2)
  })

  it('lists the panels on a client without canvas', () => {
    act(() => root.render(<CanvasPanelList workspaceId="ws" canvasId="c1" />))
    const items = [...container.querySelectorAll<HTMLElement>('[data-canvas-list-item]')].map((el) => el.dataset.canvasListItem)
    expect(items).toEqual(['p1', 'p2'])
  })
})


it('applies the first trackpad delta immediately and drops pending movement on app blur', async () => {
  act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
  await frames()
  const api = createCanvasE2E()
  act(() => { api.setZoom(1); api.setViewportOffset({ x: 0, y: 0 }) })
  const canvas = container.querySelector<HTMLElement>('[data-canvas-container]')!
  const world = container.querySelector<HTMLElement>('[data-canvas-world]')!
  const wheel = () => canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 4, deltaY: 2 }))
  act(() => { wheel(); wheel() })
  expect(world.style.transform).toBe('scale(1) translate(-4px, -2px)')
  expect(document.body.classList.contains('canvas-interacting')).toBe(true)
  act(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')) })
  expect(document.body.classList.contains('canvas-interacting')).toBe(false)
  act(() => { wheel() })
  expect(world.style.transform).toBe('scale(1) translate(-8px, -4px)')
  expect(document.body.classList.contains('canvas-interacting')).toBe(true)
  await frames(1)
  expect(world.style.transform).toBe('scale(1) translate(-8px, -4px)')
})

it('coalesces high-rate drag input and flushes the final movement on release', async () => {
  act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
  await frames()
  const api = createCanvasE2E()
  act(() => { api.setZoom(1); api.setViewportOffset({ x: 0, y: 0 }) })
  const canvas = container.querySelector<HTMLElement>('[data-canvas-container]')!
  const world = container.querySelector<HTMLElement>('[data-canvas-world]')!
  act(() => {
    canvas.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 1, clientX: 100, clientY: 100 }))
    for (let i = 1; i <= 20; i++) canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 4, clientX: 100 + i * 5, clientY: 100 + i * 2 }))
  })
  expect(world.style.transform).toBe('scale(1) translate(0px, 0px)')
  await frames(1)
  expect(world.style.transform).toBe('scale(1) translate(100px, 40px)')
  act(() => {
    canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 4, clientX: 210, clientY: 150 }))
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 1 }))
  })
  expect(world.style.transform).toBe('scale(1) translate(110px, 50px)')
  expect(document.body.classList.contains('canvas-interacting')).toBe(false)
})

it('releases temporary compositor layers after canvas interaction settles', async () => {
  act(() => root.render(<CanvasView workspaceId="ws" canvasId="c1" canvasPanelId="canvas-panel" />))
  await frames()
  act(() => createCanvasE2E().setViewportOffset({ x: 70, y: 30 }))
  const world = container.querySelector<HTMLElement>('[data-canvas-world]')!
  expect(world.classList.contains('canvas-world-moving')).toBe(true)
  expect(world.style.willChange).toBe('transform')
  await act(() => new Promise(resolve => setTimeout(resolve, 700)))
  expect(world.classList.contains('canvas-world-moving')).toBe(false)
  expect(world.style.willChange).toBe('auto')
})
