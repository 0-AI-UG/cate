import { describe, expect, it } from 'vitest'
import { stackBeside, type DockNode } from './dock'

const stack = (id: string): DockNode => ({ kind: 'stack', id, panels: [`p-${id}`] })
// a | (b over c) | d
const tree: DockNode = {
  kind: 'split', id: 'h', direction: 'horizontal', ratios: [0.25, 0.5, 0.25],
  children: [stack('a'), { kind: 'split', id: 'v', direction: 'vertical', ratios: [0.5, 0.5], children: [stack('b'), stack('c')] }, stack('d')],
}

describe('stackBeside', () => {
  it('finds the neighbour past each edge', () => {
    expect(stackBeside(tree, 'a', 'right')?.id).toBe('b')
    expect(stackBeside(tree, 'd', 'left')?.id).toBe('b')
    expect(stackBeside(tree, 'b', 'bottom')?.id).toBe('c')
    expect(stackBeside(tree, 'c', 'top')?.id).toBe('b')
    expect(stackBeside(tree, 'c', 'left')?.id).toBe('a')
  })
  it('is null at the dock\'s edge and for an unknown stack', () => {
    expect(stackBeside(tree, 'a', 'left')).toBeNull()
    expect(stackBeside(tree, 'b', 'top')).toBeNull()
    expect(stackBeside(tree, 'zz', 'right')).toBeNull()
  })
})
