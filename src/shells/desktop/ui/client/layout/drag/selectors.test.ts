import { describe, expect, it } from 'vitest'
import { selectDragSourceRole, selectDragSourceRoleForTab } from './selectors'
import { INITIAL_DRAG_STATE, type DragSource, type DragState } from './types'

const dragging = (source: DragSource): DragState => ({ ...INITIAL_DRAG_STATE, isDragging: true, source })
const tab = (from?: 'sidebar'): DragSource => ({
  workspaceId: 'w',
  panelId: 'p',
  ...(from ? { from } : {}),
  origin: { kind: 'dock-tab', dock: { layoutId: 'L' }, host: { canvasId: 'C', nodeId: 'n' }, stackId: 's' },
})

describe('drag source roles', () => {
  it('a dock tab dragged from its stack hides that tab and marks its node', () => {
    expect(selectDragSourceRoleForTab(dragging(tab()), 'p')).toBe('tab')
    expect(selectDragSourceRole(dragging(tab()), 'n')).toBe('tab')
  })

  it('a sidebar row dragging the same panel leaves the tab and its node alone', () => {
    expect(selectDragSourceRoleForTab(dragging(tab('sidebar')), 'p')).toBeNull()
    expect(selectDragSourceRole(dragging(tab('sidebar')), 'n')).toBeNull()
  })

  it('a sidebar row over the dock makes the panel\'s tab the ghost: hidden, one chip', () => {
    const over = (target: DragState['target']): DragState => ({ ...dragging(tab('sidebar')), target })
    expect(selectDragSourceRoleForTab(over({ kind: 'dock-tab', workspaceId: 'w', dock: { layoutId: 'L' }, stackId: 's2' }), 'p')).toBe('tab')
    expect(selectDragSourceRoleForTab(over({ kind: 'dock-split', workspaceId: 'w', dock: { layoutId: 'L' }, stackId: 's2', edge: 'left' }), 'p')).toBe('tab')
    expect(selectDragSourceRoleForTab(over({ kind: 'tab-slot', workspaceId: 'w', host: { windowId: 'W' }, index: 0 }), 'p')).toBeNull()
    expect(selectDragSourceRole(over({ kind: 'dock-tab', workspaceId: 'w', dock: { layoutId: 'L' }, stackId: 's2' }), 'n')).toBeNull()
  })
})
