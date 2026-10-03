// The canvas view end to end over a real client document store: nodes mount,
// the world transform follows the viewport, and the e2e surface drives it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { rect } from '@workspace/canvas/contract'
import { documentStoreFor } from '@client/document'
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
