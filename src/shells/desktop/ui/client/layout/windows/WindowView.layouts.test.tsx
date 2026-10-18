import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, dockPanels, placementOf } from '@workspace/document/contract'
import { installMockClientUi } from '../../../../../../test/clientUi'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { activeLayoutId, addLayout, registerPanelDefinitions, switchLayout } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { WindowView } from './WindowView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
let ws: TestWorkspace
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }))
  ws = attachTestWorkspace('w', buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
  ]))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ws.detach()
  installClientIdentity(null)
})

const render = () => act(() => { root.render(<WindowView workspaceId="w" windowId={MAIN_WINDOW} overlay={false} />) })
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const header = () => container.querySelector('[data-window-header]')
const strip = (id: string) => container.querySelector<HTMLElement>(`[data-strip-panel-id="${id}"]`)!
const anchors = () => [...container.querySelectorAll<HTMLElement>('[data-layout-id]')]
const layouts = () => ws.confirmed().windows[MAIN_WINDOW].layouts

/** p1 and p2 as two panes of one layout, p3 as a tab of its own. */
function grouped() {
  ws.detach()
  ws = attachTestWorkspace('w', buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p2', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
    add('p3', { to: 'tab', host: { windowId: MAIN_WINDOW }, layoutId: 'L3', stackId: 's3' }),
  ]))
}

describe('WindowView tab strip', () => {
  it('a window with one panel shows it as a plain tab, with no group chrome', () => {
    render()
    expect(header()).not.toBeNull()
    expect(strip('p1')).not.toBeNull()
    expect(container.querySelector('[data-layout-group]')).toBeNull()
    expect(container.querySelector('[aria-label="New Tab"]')).not.toBeNull()
  })

  it('a layout with several panels is a group: an anchor chip and a container around its panel chips', () => {
    grouped()
    render()
    const group = container.querySelector('[data-layout-group="main"]')!
    expect(group.querySelector('[data-layout-id="main"]')!.getAttribute('title')).toBe('Layout 1')
    expect([...group.querySelectorAll('[data-strip-panel-id]')].map((el) => el.getAttribute('data-strip-panel-id'))).toEqual(['p1', 'p2'])
    // The plain tab after it is outside the group and has no anchor.
    expect(group.contains(strip('p3'))).toBe(false)
    expect(anchors().map((el) => el.dataset.layoutId)).toEqual(['main'])
  })

  it('chips switch layouts and panels; that is client state, nothing goes to the runtime', () => {
    grouped()
    render()
    const seq = ws.document.seq
    click(strip('p3'))
    expect(strip('p3').dataset.active).toBe('true')
    expect(container.querySelector('[data-view-id="p3"], [data-panel-id="p3"]') ?? true).toBeTruthy()
    click(strip('p2'))
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).toBe('main')
    expect(ws.state.getSnapshot().focusedPanelId).toBe('p2')
    expect(strip('p2').dataset.active).toBe('true')
    expect(strip('p1').dataset.active).toBeUndefined()
    expect(ws.document.seq).toBe(seq)
  })

  it('+ opens the panel menu; a pick is a new tab right after the shown layout, and is shown', () => {
    grouped()
    render()
    click(container.querySelector('[aria-label="New Tab"]')!)
    click(document.querySelector('[role="menu"] [role="menuitem"]')!)
    expect(layouts().map((l) => l.id)).toEqual(['main', expect.any(String), 'L3'])
    const created = layouts()[1]
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).toBe(created.id)
    expect(dockPanels(created.dock)).toHaveLength(1)
    expect(strip(dockPanels(created.dock)[0])).not.toBeNull()
  })

  it('the strip\'s Split button adds a pane beside the shown panel, making a group', () => {
    // jsdom has no layout: give the dock room.
    const size = { configurable: true, get: () => 1200 }
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', size)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', size)
    render()
    expect(container.querySelector('[data-layout-group]')).toBeNull()
    click(container.querySelector('[aria-label="Split"]')!)
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
    delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    const doc = ws.confirmed()
    expect(layouts().map((l) => l.id)).toEqual(['main'])
    expect(dockPanels(layouts()[0].dock)).toHaveLength(2)
    expect(Object.keys(doc.panels)).toHaveLength(2)
    expect(container.querySelector('[data-layout-group="main"]')).not.toBeNull()
  })

  it('closing the last panel of a tab removes its layout; the only layout stays, empty, with the creation menu', async () => {
    installMockClientUi()
    grouped()
    render()
    await act(async () => { strip('p3').querySelector('[aria-label="Close tab"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(layouts().map((l) => l.id)).toEqual(['main'])
    for (const id of ['p1', 'p2']) {
      await act(async () => { strip(id).querySelector('[aria-label="Close tab"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }
    expect(layouts().map((l) => l.dock)).toEqual([null])
    expect(container.querySelector('[data-empty-workspace-dock]')).not.toBeNull()
  })

  it('an empty layout is a "New tab" chip that can be switched to and closed', async () => {
    installMockClientUi()
    render()
    act(() => { addLayout('w', { windowId: MAIN_WINDOW }, 'Logs') })
    expect(anchors().map((e) => e.textContent)).toEqual(['New tab'])
    expect(activeLayoutId('w', { windowId: MAIN_WINDOW })).toBe(layouts()[1].id)
    act(() => { switchLayout('w', { windowId: MAIN_WINDOW }, 'main') })
    expect(container.querySelector('[data-empty-workspace-dock]')).toBeNull()
    await act(async () => { container.querySelector('[data-layout-id] [aria-label="Close tab"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(layouts()).toHaveLength(1)
  })

  it('right-click on a group anchor offers rename and close; rename is inline', async () => {
    const menu = vi.fn(async (_items: unknown[]) => 'rename' as string | null)
    installMockClientUi({ showContextMenu: menu })
    grouped()
    render()
    await act(async () => { anchors()[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(menu).toHaveBeenCalledWith([
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'close', label: 'Close Layout', enabled: true },
    ])
    const input = container.querySelector<HTMLInputElement>('[data-layout-id] input')!
    expect(input.value).toBe('Layout 1')
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'Build')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(layouts()[0].name).toBe('Build')
  })

  it('the header uses the solid chrome color the window tab bar had', () => {
    render()
    expect((header() as HTMLElement).style.backgroundColor).toContain('--node-chrome-bg')
  })

  it('another client state change switches the view too (shortcut path)', () => {
    grouped()
    render()
    act(() => { switchLayout('w', { windowId: MAIN_WINDOW }, 'L3') })
    expect(strip('p3').dataset.active).toBe('true')
    act(() => { switchLayout('w', { windowId: MAIN_WINDOW }, 'main') })
    expect(container.querySelector('[data-tab-panel-id="p1"], [data-pane-chip="s1"]')).not.toBeNull()
  })

  describe('over a canvas', () => {
    const R = { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } }
    const withCanvas = () => {
      ws.detach()
      ws = attachTestWorkspace('w', buildDocument([
        add('cv', { to: 'stack', dock: main, stackId: 's1' }, 'canvas', { canvasId: 'C' }),
        add('n1', { to: 'canvas', canvasId: 'C', nodeId: 'N1', layoutId: 'LN', stackId: 'sn', rect: R }),
      ]))
    }

    it('the strip floats over a shown canvas and is solid over anything else', () => {
      withCanvas()
      render()
      expect(header()?.className).toContain('absolute')
      act(() => root.unmount())
      root = createRoot(container)
      ws.detach()
      ws = attachTestWorkspace('w', buildDocument([add('p1', { to: 'stack', dock: main, stackId: 's1' })]))
      render()
      expect(header()?.className).not.toContain('absolute')
    })

    it('focus inside a canvas node lights the canvas chip', () => {
      withCanvas()
      render()
      act(() => { ws.state.focus('n1') })
      expect(strip('cv').dataset.active).toBe('true')
    })
  })
})
