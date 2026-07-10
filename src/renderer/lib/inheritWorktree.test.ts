import { describe, expect, it } from 'vitest'
import { inheritedWorktreeFromSelection } from './inheritWorktree'
import type { PanelState } from '../../shared/types'
import type { CanvasStoreState } from '../stores/canvas/storeTypes'

type TestNode = { dockLayout: { type: 'tabs'; id: string; panelIds: string[]; activeIndex: number } }

const node = (panelId: string): TestNode => ({
  dockLayout: { type: 'tabs', id: `stack-${panelId}`, panelIds: [panelId], activeIndex: 0 },
})

function canvasState(
  selection: string[],
  selectionActive: boolean,
  nodes: Record<string, TestNode>,
): Pick<CanvasStoreState, 'selection' | 'selectionActive' | 'nodes'> {
  return { selection, selectionActive, nodes } as any
}

const panels = (list: PanelState[]): Record<string, PanelState> =>
  Object.fromEntries(list.map((p) => [p.id, p]))

describe('inheritedWorktreeFromSelection', () => {
  it('returns {} when nothing is selected', () => {
    const state = canvasState([], false, {})
    expect(inheritedWorktreeFromSelection(state, {})).toEqual({})
  })

  it('returns {} when the selection is not activated', () => {
    const state = canvasState(['n1'], false, { n1: node('t1') })
    const ps = panels([{ id: 't1', type: 'terminal', title: 'Terminal 1', isDirty: false, worktreeId: 'wt-a' }])
    expect(inheritedWorktreeFromSelection(state, ps)).toEqual({})
  })

  it('inherits worktreeId + cwd from a selected terminal', () => {
    const state = canvasState(['n1'], true, { n1: node('t1') })
    const ps = panels([
      { id: 't1', type: 'terminal', title: 'Terminal 1', isDirty: false, cwd: '/repo/wt', worktreeId: 'wt-a' },
    ])
    expect(inheritedWorktreeFromSelection(state, ps)).toEqual({ cwd: '/repo/wt', worktreeId: 'wt-a' })
  })

  it('inherits the worktreeId from a selected agent (agents carry no cwd)', () => {
    const state = canvasState(['n1'], true, { n1: node('a1') })
    const ps = panels([{ id: 'a1', type: 'agent', title: 'Agent 1', isDirty: false, worktreeId: 'wt-b' }])
    expect(inheritedWorktreeFromSelection(state, ps)).toEqual({ cwd: undefined, worktreeId: 'wt-b' })
  })

  it('returns {} when the selected node is not a terminal or agent', () => {
    const state = canvasState(['n1'], true, { n1: node('e1') })
    const ps = panels([{ id: 'e1', type: 'editor', title: 'file.ts', isDirty: false, worktreeId: 'wt-c' }])
    expect(inheritedWorktreeFromSelection(state, ps)).toEqual({})
  })

  it('uses the lead (last) selection entry as the focused node', () => {
    const state = canvasState(['n1', 'n2'], true, {
      n1: node('t1'),
      n2: node('t2'),
    })
    const ps = panels([
      { id: 't1', type: 'terminal', title: 'Terminal 1', isDirty: false, worktreeId: 'wt-a' },
      { id: 't2', type: 'terminal', title: 'Terminal 2', isDirty: false, worktreeId: 'wt-b' },
    ])
    expect(inheritedWorktreeFromSelection(state, ps)).toEqual({ cwd: undefined, worktreeId: 'wt-b' })
  })
})
