import { describe, expect, it } from 'vitest'
import type { DockSplitNode, PanelType } from '../../shared/types'
import { clampSplitDelta } from './DockSplitContainer'

const horizontalSplit: DockSplitNode = {
  type: 'split',
  id: 'split',
  direction: 'horizontal',
  children: [
    { type: 'tabs', id: 'canvas-stack', panelIds: ['canvas'], activeIndex: 0 },
    { type: 'tabs', id: 'editor-stack', panelIds: ['editor'], activeIndex: 0 },
  ],
  ratios: [0.5, 0.5],
}

const panelType = (panelId: string): PanelType => panelId as PanelType

describe('clampSplitDelta', () => {
  it('keeps a canvas at least 400px wide in a horizontal split', () => {
    expect(clampSplitDelta(horizontalSplit, 0, -0.4, 1000, panelType)).toBeCloseTo(-0.1)
  })

  it('keeps a canvas at least 300px tall in a vertical split', () => {
    const verticalSplit = { ...horizontalSplit, direction: 'vertical' as const }
    expect(clampSplitDelta(verticalSplit, 0, -0.4, 1000, panelType)).toBeCloseTo(-0.2)
  })

  it('remains movable when both canvas minimums cannot fit', () => {
    const twoCanvases: DockSplitNode = {
      ...horizontalSplit,
      children: [
        { type: 'tabs', id: 'canvas-a', panelIds: ['canvas-a'], activeIndex: 0 },
        { type: 'tabs', id: 'canvas-b', panelIds: ['canvas-b'], activeIndex: 0 },
      ],
    }
    const canvases = (): PanelType => 'canvas'
    expect(clampSplitDelta(twoCanvases, 0, 0.1, 700, canvases)).toBeCloseTo(0.1)
    expect(clampSplitDelta(twoCanvases, 0, -0.6, 700, canvases)).toBeCloseTo(-0.4)
  })
})
