import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { addLayout, registerPanelDefinitions } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { layoutMoveItems, runLayoutMove } from './layoutMenu'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
let ws: TestWorkspace

/** main window: layout `main` [cv (canvas C), t1]; a second layout `two` [t2]. */
beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: ['windows'] }))
  ws = attachTestWorkspace('w', buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('t1', { to: 'stack', dock: main, stackId: 's1' }),
  ]))
  addLayout('w', { windowId: MAIN_WINDOW }, 'Logs')
  const two = ws.confirmed().windows[MAIN_WINDOW].layouts[1].id
  ws.document.propose(add('t2', { to: 'stack', dock: { layoutId: two }, stackId: 's2' }))
})

afterEach(() => {
  ws.detach()
  installClientIdentity(null)
})

const ids = (items: { id?: string }[]) => items.map((item) => item.id)
const second = () => ws.confirmed().windows[MAIN_WINDOW].layouts[1].id

describe('layout moves', () => {
  it('a window layout offers a new window, not the main window it is in', () => {
    expect(ids(layoutMoveItems(ws.confirmed(), second()))).toEqual(['move-window'])
  })

  it('the main window keeps its last layout', () => {
    ws.document.propose({ kind: 'removeLayout', layoutId: second() })
    expect(layoutMoveItems(ws.confirmed(), 'main')).toEqual([])
  })

  it('without `windows` there is no new-window move', () => {
    installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }))
    expect(layoutMoveItems(ws.confirmed(), second())).toEqual([])
  })

  it('moves a layout into a new window', () => {
    const layoutId = second()
    expect(runLayoutMove('w', layoutId, 'move-window')).toBe(true)
    const detached = Object.values(ws.confirmed().windows).find((w) => w.kind === 'detached')!
    expect(detached.layouts.map((l) => l.id)).toEqual([layoutId])
  })

  it('an unknown id is not a move', () => {
    expect(runLayoutMove('w', second(), 'nope')).toBe(false)
  })
})
