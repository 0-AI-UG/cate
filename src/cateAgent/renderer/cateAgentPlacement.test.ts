import { describe, it, expect } from 'vitest'
import { agentAreaAnchor, agentGridPosition, AGENT_AREA_MARGIN, AGENT_GRID_GAP } from './cateAgentPlacement'
import type { CanvasNodeState, Size } from '../../shared/types'

const SIZE: Size = { width: 600, height: 400 }

function node(x: number, y: number, width: number, height: number): CanvasNodeState {
  return { origin: { x, y }, size: { width, height } } as CanvasNodeState
}

describe('agentAreaAnchor', () => {
  it('centres on the view centre when the canvas is empty', () => {
    expect(agentAreaAnchor([], SIZE, { x: 1000, y: 800 })).toEqual({ x: 700, y: 600 })
  })

  it('anchors right of the content bounding box, top-aligned', () => {
    const nodes = [node(0, 100, 500, 300), node(200, -50, 800, 400)]
    // right edge = 200 + 800 = 1000, top = -50
    expect(agentAreaAnchor(nodes, SIZE, { x: 0, y: 0 })).toEqual({ x: 1000 + AGENT_AREA_MARGIN, y: -50 })
  })
})

describe('agentGridPosition', () => {
  const anchor = { x: 2000, y: 100 }

  it('places column 0 / row 0 at the anchor', () => {
    expect(agentGridPosition(anchor, SIZE, { runKey: 't', column: 0, row: 0 })).toEqual(anchor)
  })

  it('advances columns horizontally and rows vertically by size + gap', () => {
    expect(agentGridPosition(anchor, SIZE, { runKey: 't', column: 2, row: 1 })).toEqual({
      x: 2000 + 2 * (SIZE.width + AGENT_GRID_GAP),
      y: 100 + (SIZE.height + AGENT_GRID_GAP),
    })
  })
})
