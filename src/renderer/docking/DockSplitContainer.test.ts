import { describe, expect, it } from 'vitest'
import { PANEL_MINIMUM_SIZES, type DockSplitNode, type PanelType } from '../../shared/types'
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
  it('lets a diff pane shrink below half the split down to 320px', () => {
    const split: DockSplitNode = { ...horizontalSplit, children: [
      { type: 'tabs', id: 'review-stack', panelIds: ['review'], activeIndex: 0 },
      { type: 'tabs', id: 'editor-stack', panelIds: ['editor'], activeIndex: 0 },
    ] }
    expect(clampSplitDelta(split, 0, -0.15, 1000, panelType)).toBeCloseTo(-0.15)
    expect(clampSplitDelta(split, 0, -0.4, 1000, panelType)).toBeCloseTo(320 / 999 - 0.5)
  })
  it('keeps a canvas at least its minimum wide in a horizontal split', () => {
    expect(clampSplitDelta(horizontalSplit, 0, -0.4, 2000, panelType)).toBeCloseTo(PANEL_MINIMUM_SIZES.canvas.width / 1999 - 0.5)
  })

  it('keeps a canvas at least its minimum tall in a vertical split', () => {
    const verticalSplit = { ...horizontalSplit, direction: 'vertical' as const }
    expect(clampSplitDelta(verticalSplit, 0, -0.4, 2000, panelType)).toBeCloseTo(PANEL_MINIMUM_SIZES.canvas.height / 1999 - 0.5)
  })

  it('does not shrink panes further when their minimums cannot fit', () => {
    const twoCanvases: DockSplitNode = {
      ...horizontalSplit,
      children: [
        { type: 'tabs', id: 'canvas-a', panelIds: ['canvas-a'], activeIndex: 0 },
        { type: 'tabs', id: 'canvas-b', panelIds: ['canvas-b'], activeIndex: 0 },
      ],
    }
    const canvases = (): PanelType => 'canvas'
    expect(clampSplitDelta(twoCanvases, 0, 0.1, 700, canvases)).toBe(0)
    expect(clampSplitDelta(twoCanvases, 0, -0.6, 700, canvases)).toBe(0)
  })
})
