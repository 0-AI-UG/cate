import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, canvasOf } from '@workspace/document/contract'
import { closePanel, registerPanelDefinitions } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../test/clientWorkspace'
import { installMockClientUi } from '@kernel/interaction/testing'
import './index'

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { windowId: MAIN_WINDOW, layoutId: 'main' }
const rect = { origin: { x: 40, y: 40 }, size: { width: 400, height: 300 } }

function twoCanvases() {
  return buildDocument([
    add('cv1', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C1' }),
    add('cv2', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C2' }),
    add('a', { to: 'canvas', canvasId: 'C1', nodeId: 'N1', stackId: 'ns1', rect }),
    add('b', { to: 'canvas', canvasId: 'C1', nodeId: 'N2', stackId: 'ns2', rect }),
  ])
}

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

describe('closing a canvas', () => {
  it('cancel keeps the canvas and its panels', async () => {
    ws = attachTestWorkspace('w', twoCanvases())
    const confirmCloseCanvas = vi.fn(async () => 'cancel' as const)
    installMockClientUi({ confirmCloseCanvas })
    expect(await closePanel('w', 'cv1')).toBe(false)
    expect(confirmCloseCanvas).toHaveBeenCalledWith({ panelCount: 2, canMove: true })
    expect(Object.keys(ws.confirmed().panels).sort()).toEqual(['a', 'b', 'cv1', 'cv2'])
  })

  it('move puts the panels on the other canvas and removes only the canvas', async () => {
    ws = attachTestWorkspace('w', twoCanvases())
    installMockClientUi({ confirmCloseCanvas: async () => 'move' as const })
    expect(await closePanel('w', 'cv1')).toBe(true)
    const doc = ws.confirmed()
    expect(doc.panels.cv1).toBeUndefined()
    expect(canvasOf(doc, 'a')).toBe('C2')
    expect(canvasOf(doc, 'b')).toBe('C2')
  })

  it('delete removes the panels with it', async () => {
    ws = attachTestWorkspace('w', twoCanvases())
    installMockClientUi({ confirmCloseCanvas: async () => 'delete' as const })
    expect(await closePanel('w', 'cv1')).toBe(true)
    expect(Object.keys(ws.confirmed().panels)).toEqual(['cv2'])
  })

  it('the last canvas can only close, and asks with a plain confirm without the dialog', async () => {
    ws = attachTestWorkspace('w', buildDocument([
      add('cv1', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C1' }),
      add('a', { to: 'canvas', canvasId: 'C1', nodeId: 'N1', stackId: 'ns1', rect }),
    ]))
    const ui = installMockClientUi({ confirm: vi.fn(async () => true) })
    expect(await closePanel('w', 'cv1')).toBe(true)
    expect(ui.confirm).toHaveBeenCalledWith('Close this canvas and its 1 open panel?')
    expect(ws.confirmed().panels).toEqual({})
  })
})
