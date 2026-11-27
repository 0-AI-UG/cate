import { beforeAll, describe, expect, it } from 'vitest'
import { PANEL_DEFINITIONS, panelDefinition } from '@panels/definitions'
import { registerPanelDefinitions } from '@client/host'
import type { DockNode } from '@workspace/document/contract'
import { layoutMinimum, MIN_PANE_SIZE, SPLIT_DIVIDER_SIZE } from './sizing'

const stack = (id: string, panels: string[]): DockNode => ({ kind: 'stack', id, panels, active: panels[0] ?? null } as unknown as DockNode)
const types: Record<string, string> = { n: 'note', t: 'text', term: 'terminal', b: 'browser' }
const typeOf = (id: string) => types[id]
const min = (type: string) => panelDefinition(type)!.minimumSize

beforeAll(() => registerPanelDefinitions(PANEL_DEFINITIONS))

describe('layoutMinimum', () => {
  it('is what the stack’s panels declare, smaller than the pane floor for a note or a text block', () => {
    expect(layoutMinimum(stack('s', ['n']), typeOf)).toEqual(min('note'))
    expect(layoutMinimum(stack('s', ['t']), typeOf)).toEqual(min('text'))
  })

  it('takes the largest minimum of the panels stacked together', () => {
    expect(layoutMinimum(stack('s', ['n', 'b']), typeOf)).toEqual({
      width: Math.max(min('note').width, min('browser').width),
      height: Math.max(min('note').height, min('browser').height),
    })
  })

  it('falls back to the pane floor for an unknown panel or an empty stack', () => {
    expect(layoutMinimum(stack('s', ['x']), typeOf)).toEqual(MIN_PANE_SIZE)
    expect(layoutMinimum(stack('s', []), typeOf)).toEqual(MIN_PANE_SIZE)
    expect(layoutMinimum(stack('s', ['n']))).toEqual(MIN_PANE_SIZE)
  })

  it('adds up a split along its axis', () => {
    const split = { kind: 'split', id: 'p', direction: 'horizontal', children: [stack('a', ['term']), stack('b', ['n'])], ratios: [0.5, 0.5] } as unknown as DockNode
    expect(layoutMinimum(split, typeOf)).toEqual({
      width: min('terminal').width + min('note').width + SPLIT_DIVIDER_SIZE,
      height: Math.max(min('terminal').height, min('note').height),
    })
  })
})
