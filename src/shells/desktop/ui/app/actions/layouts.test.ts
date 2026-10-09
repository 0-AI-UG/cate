import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { activeLayoutId, registerPanelDefinitions, runAction } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { BUILTIN_ACTIONS, registerBuiltinActions } from './builtin'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

let ws: TestWorkspace | null = null
let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  ws?.detach()
  ws = null
})

function setup() {
  ws = attachTestWorkspace('w', buildDocument([
    add('m', { to: 'stack', dock: { windowId: MAIN_WINDOW, layoutId: 'main' }, stackId: 's1' }),
    add('d', { to: 'window', windowId: 'W2', layoutId: 'main', stackId: 's2' }),
  ]))
  stop = registerBuiltinActions()
}

describe('layout actions', () => {
  it('act on the window the shortcut came from, the main window by default', async () => {
    setup()
    await runAction('newLayout', { workspaceId: 'w' })
    expect(ws!.confirmed().windows[MAIN_WINDOW].layouts).toHaveLength(2)
    expect(ws!.confirmed().windows.W2.layouts).toHaveLength(1)

    await runAction('newLayout', { workspaceId: 'w', windowId: 'W2' })
    expect(ws!.confirmed().windows.W2.layouts).toHaveLength(2)
    expect(ws!.confirmed().windows[MAIN_WINDOW].layouts).toHaveLength(2)
  })

  it('next and previous layout step the shown layout and wrap', async () => {
    setup()
    await runAction('newLayout', { workspaceId: 'w' })
    const second = activeLayoutId('w', MAIN_WINDOW)
    expect(second).not.toBe('main')
    await runAction('nextLayout', { workspaceId: 'w' })
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe('main')
    await runAction('previousLayout', { workspaceId: 'w' })
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(second)
    // Another window keeps its own layout.
    expect(activeLayoutId('w', 'W2')).toBe('main')
  })

  it('Alt+1..9 select the layout at that position of the window the shortcut came from', async () => {
    setup()
    await runAction('newLayout', { workspaceId: 'w' })
    await runAction('newLayout', { workspaceId: 'w' })
    const ids = ws!.confirmed().windows[MAIN_WINDOW].layouts.map((l) => l.id)
    await runAction('selectLayout1', { workspaceId: 'w' })
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(ids[0])
    await runAction('selectLayout3', { workspaceId: 'w' })
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(ids[2])
    // No such layout: nothing changes.
    await runAction('selectLayout9', { workspaceId: 'w' })
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(ids[2])
    expect(BUILTIN_ACTIONS.selectLayout2.key).toEqual({ key: '2', command: false, shift: false, option: true, control: false })
  })

  it('Ctrl+Alt+1..9 show the n-th tab of the focused panel\'s split group', async () => {
    const L = { windowId: MAIN_WINDOW, layoutId: 'main' }
    ws = attachTestWorkspace('w', buildDocument([
      add('a', { to: 'stack', dock: L, stackId: 's1' }),
      add('b', { to: 'stack', dock: L, stackId: 's1' }),
      add('c', { to: 'stack', dock: L, stackId: 's1' }),
    ]))
    stop = registerBuiltinActions()
    ws.state.focus('a')
    await runAction('selectTab2', { workspaceId: 'w' })
    expect(ws!.state.getSnapshot().focusedPanelId).toBe('b')
    expect(ws!.state.getSnapshot().activeTabs.s1).toBe('b')
    await runAction('selectTab1', { workspaceId: 'w' })
    expect(ws!.state.getSnapshot().activeTabs.s1).toBe('a')
    // No such tab: nothing changes.
    await runAction('selectTab5', { workspaceId: 'w' })
    expect(ws!.state.getSnapshot().focusedPanelId).toBe('a')
    expect(BUILTIN_ACTIONS.selectTab3.key).toEqual({ key: '3', command: false, shift: false, option: true, control: true })
  })
})
