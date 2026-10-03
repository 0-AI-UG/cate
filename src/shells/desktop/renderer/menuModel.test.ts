import { afterEach, describe, expect, it } from 'vitest'
import { storedShortcut } from '@kernel/interaction/contract'
import { registerActions } from '@client/host'
import { buildMenuModel } from './menuModel'

const stops: (() => void)[] = []
afterEach(() => { for (const stop of stops.splice(0)) stop() })

const run = { run: () => {} }

describe('menu model', () => {
  it('places actions in their menu group, ordered, with roles and separators from the skeleton', () => {
    stops.push(registerActions({
      redo: { title: 'Redo', key: storedShortcut('z', { command: true, shift: true }), menu: { bar: 'edit', group: 'history', order: 1 }, keys: { windowOnly: true } },
      undo: { title: 'Undo', key: storedShortcut('z', { command: true }), menu: { bar: 'edit', group: 'history', order: 0 }, keys: { windowOnly: true } },
      find: { title: 'Find', menu: { bar: 'edit', group: 'find' } },
    }, { redo: run, undo: run, find: run }))
    const edit = buildMenuModel().bar.find((menu) => menu.id === 'edit')!
    expect(edit.items.map((item) => (item.type === 'action' ? item.action : item.type === 'role' ? item.role : item.type))).toEqual([
      'undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll', 'separator', 'find',
    ])
    expect(edit.items[0]).toMatchObject({ label: 'Undo', shortcut: storedShortcut('z', { command: true }), registerShortcut: false })
  })

  it('gathers items naming a submenu, and drops empty menus', () => {
    stops.push(registerActions({
      'panel.browser.reload': { title: 'Reload', menu: { bar: 'panel', group: 'browser', submenu: 'Browser' } },
      'panel.browser.back': { title: 'Back', menu: { bar: 'panel', group: 'browser', submenu: 'Browser' } },
    }, { 'panel.browser.reload': run, 'panel.browser.back': run }))
    const model = buildMenuModel()
    expect(model.bar.find((menu) => menu.id === 'panel')!.items).toEqual([
      { type: 'submenu', label: 'Browser', items: [
        { type: 'action', action: 'panel.browser.reload', label: 'Reload', registerShortcut: true },
        { type: 'action', action: 'panel.browser.back', label: 'Back', registerShortcut: true },
      ] },
    ])
    expect(model.bar.find((menu) => menu.id === 'go')).toBeUndefined()
  })

  it('lists unplaced keys and aliases as hidden, guest keys apart, and skips what the client cannot run', () => {
    const k = storedShortcut('k', { command: true })
    stops.push(registerActions({
      palette: { title: 'Palette', key: k, aliasKeys: [storedShortcut('p', { command: true })], keys: { fromGuests: true } },
      pan: { title: 'Pan', key: storedShortcut('↑', { shift: true }), keys: { windowOnly: true } },
      shot: { title: 'Shot', key: storedShortcut('9', { command: true }) },
    }, { palette: run, pan: run, shot: { run: () => {}, requires: ['screenCapture'] } }))
    const model = buildMenuModel()
    expect(model.hidden).toEqual([
      { action: 'palette', label: 'Palette', shortcut: k },
      { action: 'palette', label: 'Palette', shortcut: storedShortcut('p', { command: true }) },
    ])
    expect(model.guestKeys).toEqual([{ action: 'palette', shortcut: k }])
  })
})
