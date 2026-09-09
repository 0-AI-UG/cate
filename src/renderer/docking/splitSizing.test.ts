import { expect, it } from 'vitest'
import { canSplitLayout, canSplitPane, layoutMinimum } from './splitSizing'
import type { DockLayoutNode } from '../../shared/types'

const pane = (id: string): DockLayoutNode => ({ id, type: 'tabs', panelIds: [id], activeIndex: 0 })
it('allows a diff panel in a standard narrow dock without expanding its layout', () => {
  expect(layoutMinimum(pane('review'), () => 'review')).toEqual({ width: 320, height: 220 })
  expect(layoutMinimum({ id: 'row', type: 'split', direction: 'horizontal', ratios: [0.5, 0.5], children: [pane('review'), pane('terminal')] },
    id => id as 'review' | 'terminal')).toEqual({ width: 645, height: 220 })
})
it('requires enough room for two usable panes and the divider', () => {
  expect(canSplitPane(644, 400)).toBe(false)
  expect(canSplitPane(645, 220)).toBe(true)
  expect(canSplitPane(1000, 219)).toBe(false)
})
it('uses physical pane minimums without inflating the dock to preserve uneven ratios', () => {
  const layout: DockLayoutNode = { id: 'row', type: 'split', direction: 'horizontal', ratios: [0.25, 0.75], children: [pane('a'), {
    id: 'column', type: 'split', direction: 'vertical', ratios: [0.5, 0.5], children: [pane('b'), pane('c')],
  }] }
  expect(layoutMinimum(layout)).toEqual({ width: 645, height: 445 })
  expect(layout.ratios).toEqual([0.25, 0.75])
})

it('permits a third column based on the full row instead of requiring half the row to fit two panes', () => {
  const layout: DockLayoutNode = { id: 'row', type: 'split', direction: 'horizontal', ratios: [0.5, 0.5], children: [pane('a'), pane('b')] }
  expect(canSplitPane(500, 400)).toBe(false)
  expect(canSplitLayout(layout, 'b', 1000, 400)).toBe(true)
  expect(canSplitLayout(layout, 'b', 969, 400)).toBe(false)
  expect(canSplitLayout(layout, 'b', 970, 400)).toBe(true)
  expect(canSplitLayout(layout, 'missing', 1000, 400)).toBe(false)
})

it('keeps restored half/quarter/quarter layouts within the real three-pane minimum', () => {
  expect(layoutMinimum({ id: 'row', type: 'split', direction: 'horizontal', ratios: [0.5, 0.25, 0.25], children: [pane('a'), pane('b'), pane('c')] })).toEqual({ width: 970, height: 220 })
})

it('honors every panel type minimum, including inactive tabs in a mixed stack', async () => {
  const { PANEL_MINIMUM_SIZES } = await import('../../shared/types')
  for (const [type, minimum] of Object.entries(PANEL_MINIMUM_SIZES)) {
    expect(layoutMinimum(pane('panel'), () => type as keyof typeof PANEL_MINIMUM_SIZES)).toEqual({
      width: Math.max(320, minimum.width), height: Math.max(220, minimum.height),
    })
  }
  expect(layoutMinimum({ type: 'tabs', id: 'mixed', panelIds: ['terminal', 'browser', 'agent'], activeIndex: 0 },
    id => id as 'terminal' | 'browser' | 'agent')).toEqual({ width: 400, height: 320 })
})
