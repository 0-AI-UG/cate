import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clientStateFor } from '@client/document'
import { MAIN_WINDOW, windowDockPanels } from '@workspace/document/contract'
import { activeLayoutId, createPanel, focusedPanelId, registerPanelDefinitions, runAction } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { BUILTIN_ACTIONS, registerBuiltinActions } from './builtin'
import { registerCanvasActions } from './canvas'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

let ws: TestWorkspace | null = null
let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  ws?.detach()
  ws = null
})

/** The canvas actions carry the dock's navigation keys too (one key is one action). */
function withCanvasActions(stopBuiltin: () => void): () => void {
  const stopCanvas = registerCanvasActions()
  return () => { stopCanvas(); stopBuiltin() }
}

function setup() {
  ws = attachTestWorkspace('w', buildDocument([
    add('m', { to: 'stack', dock: { layoutId: 'main' }, stackId: 's1' }),
    add('d', { to: 'window', windowId: 'W2', layoutId: 'W2-main', stackId: 's2' }),
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

  it('Ctrl+Tab and Ctrl+Shift+Tab cycle the window\'s panels in sidebar order, wrapping', async () => {
    const L = { layoutId: 'main' }
    ws = attachTestWorkspace('w', buildDocument([
      add('a', { to: 'stack', dock: L, stackId: 's1' }),
      add('b', { to: 'stack', dock: L, stackId: 's1' }),
    ]))
    stop = withCanvasActions(registerBuiltinActions())
    await runAction('newLayout', { workspaceId: 'w' })
    const c = createPanel('w', 'terminal', {})!
    const ids = windowDockPanels(ws.confirmed().windows[MAIN_WINDOW])
    await runAction('selectPanel1', { workspaceId: 'w' })
    await runAction('focusNext', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[1])
    await runAction('focusNext', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(c)
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).not.toBe('main')
    await runAction('focusNext', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[0])
    await runAction('focusPrevious', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(c)
  })

  it('Cmd+arrows move focus between the split panes of a dock', async () => {
    const L = { layoutId: 'main' }
    ws = attachTestWorkspace('w', buildDocument([
      add('a', { to: 'stack', dock: L, stackId: 's1' }),
      add('b', { to: 'split', dock: L, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    ]))
    stop = withCanvasActions(registerBuiltinActions())
    await runAction('selectPanel1', { workspaceId: 'w' })
    await runAction('navigateRight', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe('b')
    // The dock's edge: nothing changes.
    await runAction('navigateRight', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe('b')
    await runAction('navigateLeft', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe('a')
  })

  it('Shift+Escape expands the focused split pane to its window, and restores it', async () => {
    const L = { layoutId: 'main' }
    ws = attachTestWorkspace('w', buildDocument([
      add('a', { to: 'stack', dock: L, stackId: 's1' }),
      add('b', { to: 'split', dock: L, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    ]))
    stop = registerBuiltinActions()
    const maximized = () => clientStateFor('w')!.getSnapshot().maximizedStacks[MAIN_WINDOW]
    await runAction('selectPanel2', { workspaceId: 'w' })
    await runAction('expandPane', { workspaceId: 'w' })
    expect(maximized()).toBe('s2')
    await runAction('expandPane', { workspaceId: 'w' })
    expect(maximized() ?? null).toBeNull()
    expect(BUILTIN_ACTIONS.expandPane.key).toEqual({ key: 'Escape', command: false, shift: true, option: false, control: false })
  })

  it('a lone pane has nothing to expand', async () => {
    setup()
    await runAction('selectPanel1', { workspaceId: 'w' })
    await runAction('expandPane', { workspaceId: 'w' })
    expect(clientStateFor('w')!.getSnapshot().maximizedStacks[MAIN_WINDOW] ?? null).toBeNull()
  })

  it('Alt+1..9 and Alt+0 select the n-th panel of the window, layout by layout, whatever the layouts group', async () => {
    const L = { layoutId: 'main' }
    ws = attachTestWorkspace('w', buildDocument([
      add('a', { to: 'stack', dock: L, stackId: 's1' }),
      add('b', { to: 'stack', dock: L, stackId: 's1' }),
    ]))
    stop = withCanvasActions(registerBuiltinActions())
    await runAction('newLayout', { workspaceId: 'w' })
    const c = createPanel('w', 'terminal', {})!
    const ids = windowDockPanels(ws.confirmed().windows[MAIN_WINDOW])
    expect(ids).toHaveLength(3)
    expect(ids[2]).toBe(c)
    await runAction('selectPanel3', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[2])
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).toBe(ws.confirmed().windows[MAIN_WINDOW].layouts[1].id)
    await runAction('selectPanel1', { workspaceId: 'w' })
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).toBe('main')
    await runAction('selectPanel2', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[1])
    await runAction('selectPanel1', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[0])
    // No such panel: nothing changes.
    await runAction('selectPanel10', { workspaceId: 'w' })
    expect(focusedPanelId('w')).toBe(ids[0])
    expect(BUILTIN_ACTIONS.selectPanel1.key).toEqual({ key: '1', command: false, shift: false, option: true, control: false })
    expect(BUILTIN_ACTIONS.selectPanel10.key).toEqual({ key: '0', command: false, shift: false, option: true, control: false })
  })

  it('Ctrl+Alt+1..9 show the n-th tab of the focused panel\'s split group', async () => {
    const L = { layoutId: 'main' }
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
