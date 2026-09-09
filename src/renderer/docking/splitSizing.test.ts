import { expect, it } from 'vitest'
import { canSplitPane, layoutMinimum } from './splitSizing'
import type { DockLayoutNode } from '../../shared/types'

const pane = (id: string): DockLayoutNode => ({ id, type: 'tabs', panelIds: [id], activeIndex: 0 })
it('requires enough room for two usable panes and the divider', () => {
  expect(canSplitPane(644, 400)).toBe(false)
  expect(canSplitPane(645, 220)).toBe(true)
  expect(canSplitPane(1000, 219)).toBe(false)
})
it('preserves uneven and nested ratios while providing enough scrollable space', () => {
  const layout: DockLayoutNode = { id: 'row', type: 'split', direction: 'horizontal', ratios: [0.25, 0.75], children: [pane('a'), {
    id: 'column', type: 'split', direction: 'vertical', ratios: [0.5, 0.5], children: [pane('b'), pane('c')],
  }] }
  expect(layoutMinimum(layout)).toEqual({ width: 1285, height: 445 })
  expect(layout.ratios).toEqual([0.25, 0.75])
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
