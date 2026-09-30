import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, dockOf, dockPanels, findSplit } from '@workspace/document/contract'
import { installMockClientUi } from '@kernel/ui/testing'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { registerPanelCloseGuard, registerPanelDefinitions, requestPanelRename } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../testing'
import { MainWindowView } from '../windows/WindowView'
import { DockView } from './DockView'
import { presentationsFor, resetPresentations } from './presentation'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { windowId: MAIN_WINDOW }
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
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }))
  ws = attachTestWorkspace('w', fixture())
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  ws.detach()
  resetPresentations()
  installClientIdentity(null)
})

const renderDock = () => act(() => { root.render(<DockView workspaceId="w" dock={main} renderPanel={(id) => <div data-view={id}>{id}</div>} />) })
const tab = (id: string) => container.querySelector<HTMLElement>(`[data-tab-panel-id="${id}"]`)!
const stack = (id: string) => container.querySelector<HTMLElement>(`[data-dock-stack-id="${id}"]`)!
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

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
    const bar = stack('s2').querySelector<HTMLElement>('.dock-tab-bar')!
    await act(async () => { bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    const created = dockPanels(dockOf(ws.confirmed(), main)).filter((id) => ws.confirmed().panels[id].type === 'editor')
    expect(created).toHaveLength(1)
    expect(ws.state.getSnapshot().activeTabs.s2).toBe(created[0])
  })

  it('Move into New Window is offered only with `windows`, and detaches', async () => {
    const menu = vi.fn().mockResolvedValue('move-window')
    installMockClientUi({ showContextMenu: menu })
    installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: ['windows'] }))
    renderDock()
    await act(async () => { tab('p2').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(menu.mock.calls[0][0].map((item: { id?: string }) => item.id)).toContain('move-window')
    const detached = Object.values(ws.confirmed().windows).find((w) => w.kind === 'detached')
    expect(dockPanels(detached?.dock)).toEqual(['p2'])
  })

  it('maximize merges the split into tabs without an op, and minimize restores it', () => {
    renderDock()
    const seq = ws.document.seq
    const maximize = stack('s1').querySelector<HTMLButtonElement>('[aria-label="Merge splits into tabs"]')!
    click(maximize)
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(1)
    expect(stack('s1').querySelectorAll('[data-tab-panel-id]')).toHaveLength(3)
    expect(ws.document.seq).toBe(seq)
    click(stack('s1').querySelector('[aria-label="Restore previous layout"]')!)
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(2)
  })

  it('a structural change from another client consumes the merge', () => {
    renderDock()
    click(stack('s1').querySelector('[aria-label="Merge splits into tabs"]')!)
    act(() => ws.remote({ kind: 'removePanels', ids: ['p3'] }))
    expect(presentationsFor('w').getSnapshot()).toEqual([])
    expect(container.querySelectorAll('[data-dock-stack-id]')).toHaveLength(1)
    expect(stack('s1').querySelectorAll('[data-tab-panel-id]')).toHaveLength(2)
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

describe('MainWindowView without `windows`', () => {
  it('shows each detached window as a switchable tab in the one window', () => {
    act(() => ws.remote(add('d1', { to: 'window', windowId: 'W1', stackId: 'x1', bounds: { origin: { x: 0, y: 0 }, size: { width: 400, height: 300 } } })))
    act(() => { root.render(<MainWindowView workspaceId="w" />) })
    const tabs = container.querySelectorAll('[role="tab"]')
    expect(Array.from(tabs).map((t) => t.textContent)).toEqual(['Main', 'd1'])
    expect(container.querySelector('[data-dock-window="main"]')).not.toBeNull()
    click(tabs[1])
    expect(container.querySelector('[data-dock-window="W1"]')).not.toBeNull()
    expect(dockPanels(dockOf(ws.confirmed(), { windowId: 'W1' }))).toEqual(['d1'])
  })
})
