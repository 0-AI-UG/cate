import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, dockOf, dockPanels, findSplit } from '@workspace/document/contract'
import { installMockClientUi } from '../../../../../../test/clientUi'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelCloseGuard, registerPanelDefinitions, requestPanelRename } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { usePanelPaneControls } from '../../host/panelChrome'
import { DockView } from './DockView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { layoutId: 'main' }
let ws: TestWorkspace
let container: HTMLDivElement
let root: Root

function fixture() {
  return buildDocument([
    add('p1', { to: 'stack', dock: main, stackId: 's1' }),
    add('p2', { to: 'stack', dock: main, stackId: 's1' }),
    add('p3', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }),
  ])
}

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: [] }))
  ws = attachTestWorkspace('w', fixture())
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

const renderDock = () => act(() => { root.render(<DockView workspaceId="w" dock={main} host={{ windowId: 'main' }} renderPanel={(id) => <div data-view={id}>{id}</div>} />) })
const tab = (id: string) => container.querySelector<HTMLElement>(`[data-tab-panel-id="${id}"]`)!
const stack = (id: string) => container.querySelector<HTMLElement>(`[data-dock-stack-id="${id}"]`)!
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

const ProbeControls = () => <>{usePanelPaneControls()}</>

describe('DockView', () => {
  it('draws the window tree; the first tab shows until another is chosen (client state)', () => {
    renderDock()
    expect(stack('s1').querySelectorAll('[data-tab-panel-id]')).toHaveLength(2)
    expect(container.querySelector('[data-view="p1"]')).not.toBeNull()
    expect(container.querySelector('[data-view="p2"]')).toBeNull()
    const seq = ws.document.seq
    click(tab('p2'))
    expect(container.querySelector('[data-view="p2"]')).not.toBeNull()
    expect(ws.state.getSnapshot()).toMatchObject({ activeTabs: { s1: 'p2' }, focusedPanelId: 'p2' })
    // Selecting a tab sends nothing.
    expect(ws.document.seq).toBe(seq)
  })

  it('the close button asks the guard, then removes the panel', async () => {
    const guard = vi.fn().mockResolvedValue(true)
    const stop = registerPanelCloseGuard('terminal', guard)
    renderDock()
    const close = tab('p2').querySelector('span.cursor-pointer')!
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(guard).toHaveBeenCalled()
    expect(ws.confirmed().panels.p2).toBeUndefined()
    stop()
  })

  it('the tab bar menu adds a tab of the picked type to this stack', async () => {
    installMockClientUi({ showContextMenu: vi.fn().mockResolvedValue('new:editor') })
    renderDock()
    const bar = stack('s1').querySelector<HTMLElement>('.dock-tab-bar')!
    await act(async () => { bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const created = dockPanels(dockOf(ws.confirmed(), main)).filter((id) => ws.confirmed().panels[id].type === 'editor')
    expect(created).toHaveLength(1)
    expect(ws.state.getSnapshot().activeTabs.s1).toBe(created[0])
  })

  it('a pane with one panel has no tab bar: a floating chip maximizes, drags and closes it', () => {
    renderDock()
    expect(stack('s2').querySelector('.dock-tab-bar')).toBeNull()
    expect(stack('s1').querySelector('.dock-tab-bar')).not.toBeNull()
    const chip = stack('s2').querySelector('[data-pane-chip]')!
    expect([...chip.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))).toEqual(['Maximize', 'Drag', 'Close panel'])
  })

  it('a pane that is not part of a split has no controls: no floating chip, nothing for a view to draw', () => {
    ws.detach()
    ws = attachTestWorkspace('w', buildDocument([add('only', { to: 'stack', dock: main, stackId: 'so' })]))
    const Toolbar = () => <div data-probe-toolbar>{usePanelPaneControls()}</div>
    act(() => root.render(<DockView workspaceId="w" dock={main} host={{ windowId: 'main' }} renderPanel={() => <Toolbar />} />))
    expect(container.querySelector('[data-pane-chip]')).toBeNull()
    expect(container.querySelector('[data-pane-controls]')).toBeNull()
  })

  it('a view with a toolbar of its own draws the pane controls there; the floating chip stands down', () => {
    const Toolbar = () => <div data-probe-toolbar>{usePanelPaneControls()}</div>
    act(() => root.render(<DockView workspaceId="w" dock={main} host={{ windowId: 'main' }} renderPanel={(id) => (id === 'p3' ? <Toolbar /> : <div data-view={id}>{id}</div>)} />))
    expect(stack('s2').querySelector('[data-pane-chip]')).toBeNull()
    const controls = stack('s2').querySelector('[data-probe-toolbar] [data-pane-controls]')!
    expect([...controls.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label'))).toEqual(['Maximize', 'Drag', 'Close panel'])
    // Not a one-panel pane (it has a tab bar): no controls to draw.
    act(() => root.render(<DockView workspaceId="w" dock={main} host={{ windowId: 'main' }} renderPanel={() => <div data-probe-toolbar><ProbeControls /></div>} />))
    expect(stack('s1').querySelector('[data-pane-controls]')).toBeNull()
  })

  describe('the pane controls fade only over a view that fills its pane', () => {
    const faded = (el: Element) => el.className.includes('opacity-0')
    const splitWith = (type: string) => {
      ws.detach()
      ws = attachTestWorkspace('w', buildDocument([
        add('a', { to: 'stack', dock: main, stackId: 's1' }),
        add('b', { to: 'split', dock: main, beside: 's1', side: 'right', stackId: 's2', splitId: 'sp' }, type),
      ]))
    }

    it('a terminal pane\'s floating chip shows for the focused pane or the one hovered', () => {
      splitWith('terminal')
      renderDock()
      act(() => ws.state.focus('a'))
      expect(faded(stack('s2').querySelector('[data-pane-chip]')!.parentElement!)).toBe(true)
      act(() => ws.state.focus('b'))
      expect(faded(stack('s2').querySelector('[data-pane-chip]')!.parentElement!)).toBe(false)
    })

    it('a browser pane\'s floating chip stays visible, focused or not', () => {
      splitWith('browser')
      renderDock()
      act(() => ws.state.focus('a'))
      expect(faded(stack('s2').querySelector('[data-pane-chip]')!.parentElement!)).toBe(false)
    })

    it('controls a view draws in its own toolbar (Files) stay visible, focused or not', () => {
      splitWith('editor')
      const Toolbar = () => <div data-probe-toolbar>{usePanelPaneControls()}</div>
      act(() => root.render(<DockView workspaceId="w" dock={main} host={{ windowId: 'main' }} renderPanel={(id) => (id === 'b' ? <Toolbar /> : <div data-view={id}>{id}</div>)} />))
      act(() => ws.state.focus('a'))
      expect(faded(stack('s2').querySelector('[data-pane-controls]')!)).toBe(false)
    })
  })

  it('Move into New Window is offered only with `windows`, and detaches', async () => {
    const menu = vi.fn().mockResolvedValue('move-window')
    installMockClientUi({ showContextMenu: menu })
    installClientIdentity(createClientIdentity({ device: { name: 'd', publicKey: 'FP' }, features: ['windows'] }))
    renderDock()
    await act(async () => { tab('p2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(menu.mock.calls[0][0].map((item: { id?: string }) => item.id)).toContain('move-window')
    const detached = Object.values(ws.confirmed().windows).find((w) => w.kind === 'detached')
    expect(dockPanels(detached?.layouts[0].dock)).toEqual(['p2'])
  })

  it('maximize shows the stack alone for this client only; restore brings the split back', () => {
    renderDock()
    const before = ws.confirmed()
    click(stack('s1').querySelector('[aria-label="Maximize"]')!)
    expect(ws.state.getSnapshot().maximizedStacks[MAIN_WINDOW]).toBe('s1')
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-dock-pane]')).toHaveLength(0)
    expect(ws.confirmed()).toBe(before)
    click(stack('s1').querySelector('[aria-label="Restore"]')!)
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(2)
    expect(ws.state.getSnapshot().maximizedStacks[MAIN_WINDOW]).toBeUndefined()
    expect(ws.confirmed()).toBe(before)
  })

  it('a maximized stack that another client removes shows the layout as it is', () => {
    renderDock()
    act(() => ws.state.setMaximizedStack(MAIN_WINDOW, 's1'))
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(1)
    act(() => ws.remote({ kind: 'removePanels', ids: ['p1', 'p2'] }))
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(1)
    expect(stack('s2')).not.toBeNull()
    expect(container.querySelectorAll('[aria-label="Restore"]')).toHaveLength(0)
  })

  it('a divider drag redraws locally and commits one setSplitRatio at the end', () => {
    renderDock()
    const handle = container.querySelector<HTMLElement>('.cursor-col-resize')!
    const panes = Array.from(container.querySelectorAll<HTMLElement>('[data-dock-pane]')).filter((p) => p.dataset.dockPane === 's1' || p.dataset.dockPane === 's2')
    const parent = panes[0].parentElement as HTMLElement
    Object.defineProperty(parent, 'offsetWidth', { value: 1001, configurable: true })
    for (const pane of panes) Object.defineProperty(pane, 'offsetWidth', { value: 500, configurable: true })
    const seq = ws.document.seq
    act(() => { handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500 })) })
    act(() => { document.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 })) })
    expect(ws.document.seq).toBe(seq)
    expect(panes[0].style.width).toContain('0.4')
    act(() => { document.dispatchEvent(new MouseEvent('mouseup')) })
    expect(ws.document.seq).toBe(seq + 1)
    const ratios = findSplit(dockOf(ws.confirmed(), main), 'sp')!.ratios
    expect(ratios[0]).toBeCloseTo(0.4, 2)
    expect(ratios[0] + ratios[1]).toBeCloseTo(1, 5)
  })

  it('rename: a request opens the input, Enter sends updatePanel', () => {
    renderDock()
    act(() => requestPanelRename('w', 'p1'))
    const input = tab('p1').querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Build')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(ws.confirmed().panels.p1.title).toBe('Build')
  })
})
