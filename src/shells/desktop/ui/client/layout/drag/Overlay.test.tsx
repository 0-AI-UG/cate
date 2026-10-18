import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { DragOverlay } from './Overlay'
import { useDragStore } from './store'
import { INITIAL_DRAG_STATE, type DropTarget } from './types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  act(() => useDragStore.getState().applyDragState(INITIAL_DRAG_STATE))
})

function drag(target: DropTarget) {
  act(() => useDragStore.getState().applyDragState({
    ...INITIAL_DRAG_STATE,
    isDragging: true,
    source: { workspaceId: 'ws', panelId: 'p', origin: { kind: 'layout', host: { windowId: 'main' }, layoutId: 'L' } },
    panel: { id: 'p', type: 'terminal', title: 'Layout' },
    grab: { x: 0, y: 0 },
    ghostSize: { width: 200, height: 100 },
    cursor: { client: { x: 50, y: 50 }, screen: { x: 50, y: 50 }, insideWindow: true },
    target,
  }))
}

describe('DragOverlay ghost on a canvas', () => {
  const add = { kind: 'canvas-add', workspaceId: 'ws', canvasId: 'C', origin: { x: 0, y: 0 }, size: { width: 200, height: 100 }, zoom: 1 } as const

  it('says where it lands, or why it cannot', async () => {
    root = createRoot(document.createElement('div'))
    await act(async () => root!.render(<DragOverlay />))
    drag(add)
    expect(document.querySelector('[data-drag-overlay-ghost]')?.textContent).toContain('Drop to place')
    expect(document.querySelector('[data-drag-refused]')).toBeNull()
    drag({ ...add, refused: 'Cannot add a recursive canvas item' })
    expect(document.querySelector('[data-drag-refused]')?.textContent).toContain('Cannot add a recursive canvas item')
  })
})
