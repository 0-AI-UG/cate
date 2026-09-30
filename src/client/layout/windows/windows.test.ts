import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import type { Rect } from '@workspace/canvas/contract'
import { installMockClientUi } from '@kernel/ui/testing'
import { registerPanelCloseGuard } from '@client/host'
import { add, attachTestWorkspace, buildDocument, type TestWorkspace } from '../testing'
import { clampToScreens } from './bounds'
import { closeDetachedWindow } from './closeWindow'
import { detachedWindows, panelWindowIndex, panelsByWindow, windowTitle } from './panelIndex'
import type { WindowRef, WindowsPort } from './ports'
import { syncDetachedWindows } from './windowSync'

const main = { windowId: MAIN_WINDOW }
const bounds = (x: number): Rect => ({ origin: { x, y: 100 }, size: { width: 800, height: 600 } })

function fixture() {
  return buildDocument([
    add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
    add('onCanvas', { to: 'canvas', canvasId: 'C', nodeId: 'N', stackId: 'ns', rect: bounds(0) }),
    add('d1', { to: 'window', windowId: 'W1', stackId: 'ws1', bounds: bounds(200) }),
    add('d2', { to: 'stack', dock: { windowId: 'W1' }, stackId: 'ws1' }),
  ])
}

let ws: TestWorkspace | null = null
afterEach(() => {
  ws?.detach()
  ws = null
})

describe('the cross-window panel index', () => {
  it('is derived from the document, canvas children with their canvas', () => {
    const doc = fixture()
    expect(Object.fromEntries(panelWindowIndex(doc))).toEqual({ cv: MAIN_WINDOW, onCanvas: MAIN_WINDOW, d1: 'W1', d2: 'W1' })
    expect(panelsByWindow(doc)).toEqual({ [MAIN_WINDOW]: ['cv', 'onCanvas'], W1: ['d1', 'd2'] })
    expect(detachedWindows(doc).map((w) => w.id)).toEqual(['W1'])
    expect(windowTitle(doc, 'W1')).toBe('d1')
  })
})

describe('clampToScreens', () => {
  const screens = [{ x: 0, y: 0, width: 1440, height: 900 }, { x: 1440, y: 0, width: 1920, height: 1080 }]
  it('keeps a window on the screen that holds most of it', () => {
    expect(clampToScreens({ origin: { x: 1300, y: 50 }, size: { width: 800, height: 600 } }, screens)).toEqual({ origin: { x: 1440, y: 50 }, size: { width: 800, height: 600 } })
  })
  it('pulls an off-screen window back and shrinks an oversized one', () => {
    expect(clampToScreens({ origin: { x: -5000, y: -40 }, size: { width: 3000, height: 600 } }, screens)).toEqual({ origin: { x: 0, y: 0 }, size: { width: 1440, height: 600 } })
  })
})

function fakePort() {
  const opened: (WindowRef & { bounds: Rect })[] = []
  const closed: WindowRef[] = []
  const moved: [WindowRef, Rect][] = []
  let report: ((window: WindowRef, bounds: Rect) => void) | null = null
  const port: WindowsPort = {
    open: (w) => { opened.push(w) },
    close: (w) => { closed.push(w) },
    setBounds: (w, b) => { moved.push([w, b]) },
    onBoundsChanged: (listener) => {
      report = listener
      return () => { report = null }
    },
  }
  return { port, opened, closed, moved, report: (w: WindowRef, b: Rect) => report?.(w, b) }
}

describe('syncDetachedWindows', () => {
  it('opens, moves and closes native windows with the document', () => {
    ws = attachTestWorkspace('w', fixture())
    const fake = fakePort()
    const stop = syncDetachedWindows('w', fake.port)
    expect(fake.opened).toEqual([{ workspaceId: 'w', windowId: 'W1', bounds: bounds(200) }])

    ws.remote({ kind: 'setWindowBounds', windowId: 'W1', bounds: bounds(300) })
    expect(fake.moved).toEqual([[{ workspaceId: 'w', windowId: 'W1' }, bounds(300)]])

    ws.remote(add('d3', { to: 'window', windowId: 'W2', stackId: 'ws2', bounds: bounds(50) }))
    expect(fake.opened.map((w) => w.windowId)).toEqual(['W1', 'W2'])

    ws.remote({ kind: 'closeWindow', windowId: 'W2' })
    expect(fake.closed).toEqual([{ workspaceId: 'w', windowId: 'W2' }])
    stop()
    expect(fake.closed.map((w) => w.windowId)).toEqual(['W2', 'W1'])
  })

  it('a move here becomes one setWindowBounds op, not an undo step', () => {
    ws = attachTestWorkspace('w', fixture())
    const fake = fakePort()
    const stop = syncDetachedWindows('w', fake.port)
    fake.report({ workspaceId: 'w', windowId: 'W1' }, bounds(640))
    expect(ws.confirmed().windows.W1.bounds).toEqual(bounds(640))
    expect(ws.document.getUndoState().canUndo).toBe(false)
    // The echo of our own move does not move the window again.
    expect(fake.moved).toEqual([])
    stop()
  })
})

describe('closeDetachedWindow', () => {
  it('asks first, runs the panels close guards, then sends closeWindow', async () => {
    ws = attachTestWorkspace('w', fixture())
    const ui = installMockClientUi({ confirm: vi.fn().mockResolvedValue(true) })
    const guard = vi.fn().mockResolvedValue(true)
    const stop = registerPanelCloseGuard('terminal', guard)
    expect(await closeDetachedWindow('w', 'W1')).toBe(true)
    expect(ui.confirm).toHaveBeenCalledWith('Close this window and its 2 panels?')
    expect(guard).toHaveBeenCalledTimes(2)
    expect(ws.confirmed().windows.W1).toBeUndefined()
    expect(ws.confirmed().panels.d1).toBeUndefined()
    stop()
  })

  it('keeps the window when the user declines', async () => {
    ws = attachTestWorkspace('w', fixture())
    installMockClientUi({ confirm: vi.fn().mockResolvedValue(false) })
    expect(await closeDetachedWindow('w', 'W1')).toBe(false)
    expect(ws.confirmed().windows.W1).toBeDefined()
  })

  it('never closes the main window', async () => {
    ws = attachTestWorkspace('w', fixture())
    expect(await closeDetachedWindow('w', MAIN_WINDOW)).toBe(false)
  })
})
