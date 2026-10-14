import { describe, expect, it } from 'vitest'
import type { DockNode } from '@workspace/document/contract'
import { glyphBoxes } from './LayoutGlyph'

const stack = (id: string): DockNode => ({ kind: 'stack', id, panels: [`p-${id}`] })
// a | (b over c), as in the strip's mockup
const tree: DockNode = {
  kind: 'split', id: 'h', direction: 'horizontal', ratios: [0.5, 0.5],
  children: [stack('a'), { kind: 'split', id: 'v', direction: 'vertical', ratios: [0.5, 0.5], children: [stack('b'), stack('c')] }],
}

describe('glyphBoxes', () => {
  it('draws one box per pane, split by the tree\'s directions and ratios, a gap apart', () => {
    expect(glyphBoxes(tree, 16, 12, 2)).toEqual([
      { stackId: 'a', x: 0, y: 0, width: 7, height: 12 },
      { stackId: 'b', x: 9, y: 0, width: 7, height: 5 },
      { stackId: 'c', x: 9, y: 7, width: 7, height: 5 },
    ])
  })
  it('draws an empty layout as one blank pane', () => {
    expect(glyphBoxes(null, 16, 12, 2)).toEqual([{ stackId: null, x: 0, y: 0, width: 16, height: 12 }])
  })
})
