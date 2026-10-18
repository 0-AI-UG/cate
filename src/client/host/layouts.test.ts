import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../test/clientWorkspace'
import { createPanel } from './createPanel'
import { registerPanelDefinitions } from './definitions'
import { activeLayoutId, addLayout, moveLayout, removeLayout, renameLayout, switchLayout } from './layouts'
import { revealPanel } from './reveal'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const L1 = { layoutId: 'main' }
const MAIN = { windowId: MAIN_WINDOW }

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

const fixture = () => buildDocument([add('t1', { to: 'stack', dock: L1, stackId: 's1' }, 'terminal')])

describe('layouts on the client', () => {
  it('addLayout adds an empty layout and shows it; switching is client state, not a document change', () => {
    ws = attachTestWorkspace('w', fixture())
    expect(activeLayoutId('w', MAIN)).toBe('main')
    const id = addLayout('w', MAIN, 'Logs')!
    expect(activeLayoutId('w', MAIN)).toBe(id)
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts.map((l) => l.name)).toEqual(['Layout 1', 'Logs'])
    const before = ws.confirmed()
    expect(switchLayout('w', MAIN, 'main')).toBe(true)
    expect(ws.confirmed()).toBe(before)
    expect(activeLayoutId('w', MAIN)).toBe('main')
    expect(switchLayout('w', MAIN, 'nope')).toBe(false)
  })

  it('a new panel lands in the layout this client shows', () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN)!
    const id = createPanel('w', 'terminal', {})!
    expect(placementOf(ws.confirmed(), id)?.dock).toEqual({ layoutId: second })
    switchLayout('w', MAIN, 'main')
    // The shown layout is not empty: the panel becomes a tab right after it.
    const other = createPanel('w', 'terminal', {})!
    const layouts = ws.confirmed().windows.main.layouts.map((l) => l.id)
    expect(layouts.indexOf(placementOf(ws.confirmed(), other)!.dock.layoutId)).toBe(layouts.indexOf('main') + 1)
  })

  it('revealing a panel in a hidden layout shows that layout first', async () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN)!
    const hidden = createPanel('w', 'terminal', {})!
    switchLayout('w', MAIN, 'main')
    expect(await revealPanel('w', hidden)).toBe(true)
    expect(activeLayoutId('w', MAIN)).toBe(second)
    expect(ws.state.getSnapshot().focusedPanelId).toBe(hidden)
  })

  it('a layout survives rename, and removal drops it and falls back to the first', () => {
    ws = attachTestWorkspace('w', fixture())
    const second = addLayout('w', MAIN)!
    expect(renameLayout('w', second, '  Build  ')).toBe(true)
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts[1].name).toBe('Build')
    expect(removeLayout('w', second)).toBe(true)
    expect(activeLayoutId('w', MAIN)).toBe('main')
    expect(removeLayout('w', 'main')).toBe(false)
  })

  it('layouts of a canvas node are shown per node; moving one to a window or node shows it there', () => {
    ws = attachTestWorkspace('w', buildDocument([
      add('cv', { to: 'stack', dock: L1, stackId: 's1' }, 'canvas', { canvasId: 'canvas-cv' }),
      add('n', { to: 'canvas', canvasId: 'canvas-cv', nodeId: 'n1', layoutId: 'ln1', stackId: 'sn1', rect: { origin: { x: 0, y: 0 }, size: { width: 300, height: 200 } } }, 'terminal'),
    ]))
    const node = { canvasId: 'canvas-cv', nodeId: 'n1' }
    const extra = addLayout('w', node)!
    expect(activeLayoutId('w', node)).toBe(extra)
    expect(activeLayoutId('w', MAIN)).toBe('main')
    expect(switchLayout('w', node, 'ln1')).toBe(true)
    expect(switchLayout('w', node, extra)).toBe(true)
    expect(activeLayoutId('w', node)).toBe(extra)

    expect(moveLayout('w', 'ln1', { to: 'window', windowId: 'W' })).toBe(true)
    expect(ws.confirmed().windows.W.layouts.map((l) => l.id)).toEqual(['ln1'])
    expect(activeLayoutId('w', { windowId: 'W' })).toBe('ln1')
    expect(ws.confirmed().canvases['canvas-cv'].nodes.n1).toBeUndefined()
    expect(moveLayout('w', 'main', { to: 'window', windowId: 'W2' })).toBe(false)
  })
})
