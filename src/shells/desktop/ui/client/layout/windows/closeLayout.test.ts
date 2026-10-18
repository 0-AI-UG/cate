import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { documentStoreFor } from '@client/document'
import { registerPanelCloseGuard, registerPanelDefinitions } from '@client/host'
import { installMockClientUi } from '../../../../../../test/clientUi'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { closeLayout } from './closeLayout'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

let ws: TestWorkspace
afterEach(() => ws.detach())

const setup = () => {
  ws = attachTestWorkspace('w', buildDocument([
    add('p1', { to: 'stack', dock: { layoutId: 'main' }, stackId: 's1' }),
    add('p2', { to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'L2', stackId: 's2' }),
  ]))
  return vi.spyOn(documentStoreFor('w')!, 'propose')
}

describe('closeLayout', () => {
  it('keeps the layout when the layout confirm is declined', async () => {
    const propose = setup()
    installMockClientUi({ confirm: vi.fn(async () => false) })
    expect(await closeLayout('w', 'L2')).toBe(false)
    expect(propose).not.toHaveBeenCalled()
  })

  it('sends the panels whose guard chose to discard along with the removal', async () => {
    const propose = setup()
    installMockClientUi({ confirm: vi.fn(async () => true) })
    const stop = registerPanelCloseGuard('terminal', () => 'discard')
    expect(await closeLayout('w', 'L2')).toBe(true)
    expect(propose).toHaveBeenCalledWith({ kind: 'removeLayout', layoutId: 'L2', discard: ['p2'] })
    stop()
  })

  it('keeps the layout when a panel guard declines', async () => {
    const propose = setup()
    installMockClientUi({ confirm: vi.fn(async () => true) })
    const stop = registerPanelCloseGuard('terminal', () => false)
    expect(await closeLayout('w', 'L2')).toBe(false)
    expect(propose).not.toHaveBeenCalled()
    stop()
  })

  it('never closes the last layout of a host', async () => {
    setup()
    installMockClientUi({ confirm: vi.fn(async () => true) })
    ws.detach()
    ws = attachTestWorkspace('w', buildDocument([add('p1', { to: 'stack', dock: { layoutId: 'main' }, stackId: 's1' })]))
    expect(await closeLayout('w', 'main')).toBe(false)
  })
})
