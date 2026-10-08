import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { activeLayoutId, registerPanelDefinitions, runAction } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { registerBuiltinActions } from './builtin'

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
})
