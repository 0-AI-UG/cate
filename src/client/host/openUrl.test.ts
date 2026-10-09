import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { installMockClientUi } from '../../test/clientUi'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../test/clientWorkspace'
import { registerPanelDefinitions } from './definitions'
import { openUrlFor, openUrlInPanel } from './openUrl'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

const fixture = () => buildDocument([add('t1', { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 's1' }, 'terminal')])
const browsers = (w: TestWorkspace) => Object.values(w.confirmed().panels).filter((panel) => panel.type === 'browser')

describe('openUrlFor', () => {
  it('opens a loopback URL in a new browser panel next to `near`, never in the system browser', () => {
    const ui = installMockClientUi()
    ws = attachTestWorkspace('w', fixture())
    openUrlFor('w', 'http://localhost:3000/', 't1')
    const [panel] = browsers(ws)
    expect(panel).toBeDefined()
    expect(placementOf(ws.confirmed(), panel.id)).toMatchObject({ stackId: 's1' })
    expect(ui.openExternal).not.toHaveBeenCalled()
  })

  it('opens any other URL in the system browser', () => {
    const ui = installMockClientUi()
    ws = attachTestWorkspace('w', fixture())
    openUrlFor('w', 'https://example.com/x')
    expect(ui.openExternal).toHaveBeenCalledWith('https://example.com/x')
    expect(browsers(ws)).toEqual([])
  })

  it('without a workspace a loopback URL is dropped, not sent to the system browser', () => {
    const ui = installMockClientUi()
    openUrlFor(null, 'http://127.0.0.1:5173/')
    expect(ui.openExternal).not.toHaveBeenCalled()
  })
})

describe('openUrlInPanel', () => {
  it('opens any URL in a browser panel of the workspace', () => {
    ws = attachTestWorkspace('w', fixture())
    expect(openUrlInPanel('w', 'https://auth.example.com/login')).toBe(true)
    expect(browsers(ws)).toHaveLength(1)
    expect(openUrlInPanel(undefined, 'https://auth.example.com/login')).toBe(false)
  })
})
