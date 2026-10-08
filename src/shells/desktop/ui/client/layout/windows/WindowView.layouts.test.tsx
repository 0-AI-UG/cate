import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAIN_WINDOW, placementOf } from '@workspace/document/contract'
import { installMockClientUi } from '@kernel/interaction/testing'
import { createClientIdentity, installClientIdentity } from '@client/connections'
import { activeLayoutId, addLayout, createPanel, registerPanelDefinitions, switchLayout } from '@client/host'
import { add, attachTestWorkspace, buildDocument, testPanelDefinitions, type TestWorkspace } from '../../../../../../test/clientWorkspace'
import { WindowView } from './WindowView'
import { dropChanges } from '../drag/commit'
import { proposeDrop } from '../drag/useDragOp'
import { DragOverlay } from '../drag/Overlay'
import { useDragStore } from '../drag/store'
import { getDropZoneEntries } from '../drag/registry'
import { resolveDrop } from '../drag/resolve'

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
const layoutIdOfShown = () => container.querySelector<HTMLElement>('[data-layout-id][data-active]')?.dataset.layoutId
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

  it('a dragged panel can be dropped on the chip of another layout; its own layout\'s chip is a no-op', () => {
    render()
    act(() => { addLayout('w', MAIN_WINDOW, 'Two') })
    const moved = createPanel('w', 'terminal', {})!
    expect(placementOf(ws.confirmed(), moved)?.dock).toMatchObject({ layoutId: expect.not.stringMatching(/^main$/) })

    const chips = getDropZoneEntries().filter((e) => e.id.startsWith('layout-chip-'))
    expect(chips.map((e) => 'layoutId' in e.dock && e.dock.layoutId)).toEqual(['main', expect.any(String)])
    const chipOf = (layoutId: string) => chips.find((e) => 'layoutId' in e.dock && e.dock.layoutId === layoutId)!

    const source = { workspaceId: 'w', panelId: moved, origin: { kind: 'dock-tab' as const, dock: placementOf(ws.confirmed(), moved)!.dock, stackId: placementOf(ws.confirmed(), moved)!.stackId } }
    const cursor = { client: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, insideWindow: true }
    const resolveOver = (...zones: typeof chips) => resolveDrop(cursor, source, { x: 0, y: 0 }, { width: 1, height: 1 }, 'terminal', {
      env: { canvasAtCursor: () => null, dropZones: zones, canDetach: () => false },
    })
    // Over the chip of the layout the panel is already in: nothing, even with the
    // header's new-layout drop behind it.
    const own = placementOf(ws.confirmed(), moved)!.dock
    const newLayoutZone = getDropZoneEntries().find((e) => e.id.startsWith('layout-new-'))!
    expect(resolveOver(chipOf((own as { layoutId: string }).layoutId), newLayoutZone)).toBeNull()
    const target = resolveOver(chipOf('main'))
    expect(target).toEqual({ kind: 'dock-zone', workspaceId: 'w', dock: { windowId: MAIN_WINDOW, layoutId: 'main' }, edge: undefined })

    const changes = dropChanges(ws.confirmed(), source, target!, { id: moved, type: 'terminal', title: 'T' }, { newId: () => crypto.randomUUID() })!
    for (const change of changes) act(() => { ws.document.propose(change) })
    expect(placementOf(ws.confirmed(), moved)?.dock).toEqual({ windowId: MAIN_WINDOW, layoutId: 'main' })
    // The layout it left stays, empty, and offers the creation menu.
    const layouts = ws.confirmed().windows[MAIN_WINDOW].layouts
    expect(layouts.map((l) => [l.dock === null])).toEqual([[false], [true]])
    // This client still shows it, so the creation menu is up; a pick fills that layout.
    expect(container.querySelector('[data-empty-workspace-dock]')).not.toBeNull()
    act(() => { container.querySelector<HTMLElement>('[data-empty-workspace-dock] button')!.click() })
    const filled = ws.confirmed().windows[MAIN_WINDOW].layouts[1]
    expect(filled.dock).not.toBeNull()
    expect(layoutIdOfShown()).toBe(filled.id)
  })

  it('the chip a dragged panel would join is solid accent, never the dashed new-layout ghost', () => {
    render()
    act(() => { addLayout('w', MAIN_WINDOW, 'Two') })
    const dock = { windowId: MAIN_WINDOW, layoutId: 'main' }
    act(() => { useDragStore.setState({ isDragging: true, target: { kind: 'dock-zone', workspaceId: 'w', dock } }) })
    expect(entries().map((e) => e.hasAttribute('data-join-target'))).toEqual([true, false])
    expect(entries()[0].style.boxShadow).toContain('inset')
    expect(container.querySelector('[data-new-layout-ghost]')).toBeNull()
    // The overlay adds no dashed zone outline over the chip.
    act(() => { useDragStore.setState({ cursor: { client: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, insideWindow: true }, panel: { id: 'p1', type: 'terminal', title: 'T' }, grab: { x: 0, y: 0 }, ghostSize: { width: 10, height: 10 } }) })
    act(() => { root.render(<><WindowView workspaceId="w" windowId={MAIN_WINDOW} overlay={false} /><DragOverlay /></>) })
    expect(document.querySelector('[data-drag-indicator="zone"]')).toBeNull()
    act(() => { useDragStore.setState({ isDragging: false, target: null }) })
    expect(entries().some((e) => e.hasAttribute('data-join-target'))).toBe(false)
  })

  it('a panel dragged onto the header becomes a new layout, shown with a ghost chip meanwhile', () => {
    render()
    const before = ws.confirmed()
    const source = {
      workspaceId: 'w',
      panelId: 'p1',
      origin: { kind: 'dock-tab' as const, dock: placementOf(before, 'p1')!.dock, stackId: placementOf(before, 'p1')!.stackId },
    }
    // The header's own drop: no chip of the panel's layout in front of it.
    const zones = getDropZoneEntries().filter((e) => e.id.startsWith('layout-new-'))
    const env = { canvasAtCursor: () => null, dropZones: zones, canDetach: () => false }
    const cursor = { client: { x: 0, y: 0 }, screen: { x: 0, y: 0 }, insideWindow: true }
    const target = resolveDrop(cursor, source, { x: 0, y: 0 }, { width: 1, height: 1 }, 'terminal', { env })
    expect(target).toEqual({ kind: 'layout-new', workspaceId: 'w', windowId: MAIN_WINDOW })

    // While the cursor is over the header, a ghost layout chip previews the drop.
    expect(container.querySelector('[data-new-layout-ghost]')).toBeNull()
    act(() => { useDragStore.setState({ isDragging: true, target }) })
    expect(container.querySelector('[data-new-layout-ghost]')).not.toBeNull()
    act(() => { useDragStore.setState({ isDragging: false, target: null }) })
    expect(container.querySelector('[data-new-layout-ghost]')).toBeNull()

    const changes = dropChanges(before, source, target!, { id: 'p1', type: 'terminal', title: 'T' }, { newId: () => crypto.randomUUID() })!
    act(() => { proposeDrop('w', changes, 'p1', true) })
    const layouts = ws.confirmed().windows[MAIN_WINDOW].layouts
    expect(layouts.map((l) => l.dock === null)).toEqual([true, false]) // the old layout is left empty, the new holds p1
    expect(placementOf(ws.confirmed(), 'p1')?.dock).toEqual({ windowId: MAIN_WINDOW, layoutId: layouts[1].id })
    // The drop shows the new layout.
    expect(activeLayoutId('w', MAIN_WINDOW)).toBe(layouts[1].id)
    expect(container.querySelector('[data-tab-panel-id="p1"]')).not.toBeNull()
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
