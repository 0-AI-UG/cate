import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { installMockClientUi } from '@kernel/interaction/testing'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { addLayout, registerPanelDefinitions, switchLayout } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { WindowView } from './WindowView'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => registerPanelDefinitions(testPanelDefinitions()))

const main = { windowId: MAIN_WINDOW, layoutId: 'main' }
let ws: TestWorkspace
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  installClientIdentity(createClientIdentity({ device: { name: 'd', keyFingerprint: 'FP' }, features: [] }))
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
const entries = () => [...container.querySelectorAll<HTMLElement>('[data-layout-id]')]

describe('WindowView layouts', () => {
  it('the main window header always shows its layouts as chips; the one layout cannot be closed', () => {
    render()
    expect(header()).not.toBeNull()
    expect(entries().map((e) => e.textContent)).toEqual(['Layout 1'])
    expect(container.querySelector('[aria-label="Close layout"]')).toBeNull()
    expect(container.querySelector('[data-tab-panel-id="p1"]')).not.toBeNull()
  })

  it('shows the active layout\'s dock; the chips switch layouts, not panels', () => {
    render()
    act(() => { addLayout('w', MAIN_WINDOW, 'Logs') })
    expect(entries().map((e) => e.textContent)).toEqual(['Layout 1', 'Logs'])
    // The new layout is empty and active: p1 (in the first layout) is not drawn.
    expect(entries()[1].dataset.active).toBe('true')
    expect(container.querySelector('[data-tab-panel-id="p1"]')).toBeNull()

    const seq = ws.document.seq
    click(entries()[0])
    expect(container.querySelector('[data-tab-panel-id="p1"]')).not.toBeNull()
    expect(entries()[0].dataset.active).toBe('true')
    // Switching is client state: nothing went to the runtime.
    expect(ws.document.seq).toBe(seq)
  })

  it('the header uses the solid chrome color the window tab bar had', () => {
    render()
    expect((header() as HTMLElement).style.backgroundColor).toContain('--node-chrome-bg')
  })

  it('the window docks use the compact tab header (the canvas window one)', () => {
    render()
    const bar = container.querySelector('.dock-tab-bar')!
    expect(bar.className).toContain('min-h-[26px]')
    expect(bar.className).not.toContain('app-header-bar')
  })

  it('another client state change switches the view too (shortcut path)', () => {
    render()
    act(() => { addLayout('w', MAIN_WINDOW) })
    act(() => { switchLayout('w', MAIN_WINDOW, 'main') })
    expect(container.querySelector('[data-tab-panel-id="p1"]')).not.toBeNull()
  })

  it('right-click offers rename and close; rename is inline and a blank result keeps it unnamed', async () => {
    const menu = vi.fn(async (_items: unknown[]) => 'rename' as string | null)
    installMockClientUi({ showContextMenu: menu })
    render()
    act(() => { addLayout('w', MAIN_WINDOW) })
    await act(async () => { entries()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    expect(menu).toHaveBeenCalledWith([
      { id: 'rename', label: 'Rename' },
      { type: 'separator' },
      { id: 'close', label: 'Close Layout', enabled: true },
    ])
    const input = container.querySelector<HTMLInputElement>('[data-layout-id] input')!
    expect(input.value).toBe('Layout 2')
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      set.call(input, 'Build')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts[1].name).toBe('Build')
  })

  it('closing a layout from its chip removes it (empty layouts need no confirm)', async () => {
    installMockClientUi()
    render()
    act(() => { addLayout('w', MAIN_WINDOW) })
    const close = container.querySelectorAll<HTMLElement>('[aria-label="Close layout"]')[1]
    await act(async () => { close.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(ws.confirmed().windows[MAIN_WINDOW].layouts).toHaveLength(1)
    expect(container.querySelector('[aria-label="Close layout"]')).toBeNull()
  })
})
