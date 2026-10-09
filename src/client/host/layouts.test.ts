import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../test/clientWorkspace'
import { createPanel } from './createPanel'
import { registerPanelDefinitions } from './definitions'
import { activeLayoutId, addLayout, removeLayout, renameLayout, selectLayoutAt, stepLayout, switchLayout } from './layouts'
import { revealPanel } from './reveal'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const L1 = { windowId: MAIN_WINDOW, layoutId: 'main' }

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

const fixture = () => buildDocument([add('t1', { to: 'stack', dock: L1, stackId: 's1' }, 'terminal')])

describe('layouts on the client', () => {
  it('addLayout adds an empty layout and shows it; switching is client state, not a document change', () => {
    ws = attachTestWorkspace('w', fixture())
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe('main')
    const id = addLayout('w', MAIN_WINDOW, 'Logs')!
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(id)
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts.map((l) => l.name)).toEqual(['Layout 1', 'Logs'])
    const before = ws.confirmed()
    expect(switchLayout('w', MAIN_WINDOW, 'main')).toBe(true)
    expect(ws.confirmed()).toBe(before)
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe('main')
    expect(switchLayout('w', MAIN_WINDOW, 'nope')).toBe(false)
  })

  it('stepLayout wraps around, and selectLayoutAt picks by position', () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN_WINDOW)!
    expect(stepLayout('w', MAIN_WINDOW, 1)).toBe(true)
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe('main')
    stepLayout('w', MAIN_WINDOW, -1)
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(second)
    expect(selectLayoutAt('w', MAIN_WINDOW, 0)).toBe(true)
    expect(selectLayoutAt('w', MAIN_WINDOW, 5)).toBe(false)
  })

  it('a new panel lands in the layout this client shows', () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN_WINDOW)!
    const id = createPanel('w', 'terminal', {})!
    expect(placementOf(ws.confirmed(), id)?.dock).toEqual({ windowId: MAIN_WINDOW, layoutId: second })
    switchLayout('w', MAIN_WINDOW, 'main')
    const other = createPanel('w', 'terminal', {})!
    expect(placementOf(ws.confirmed(), other)?.dock).toEqual(L1)
  })

  it('revealing a panel in a hidden layout shows that layout first', async () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN_WINDOW)!
    const hidden = createPanel('w', 'terminal', {})!
    switchLayout('w', MAIN_WINDOW, 'main')
    expect(await revealPanel('w', hidden)).toBe(true)
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(second)
    expect(ws.state.getSnapshot().focusedPanelId).toBe(hidden)
  })

  it('a layout survives rename, and removal drops it and falls back to the first', () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN_WINDOW)!
    expect(renameLayout('w', MAIN_WINDOW, second, '  Build  ')).toBe(true)
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts[1].name).toBe('Build')
    expect(removeLayout('w', MAIN_WINDOW, second)).toBe(true)
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe('main')
    expect(removeLayout('w', MAIN_WINDOW, 'main')).toBe(false)
  })
})
