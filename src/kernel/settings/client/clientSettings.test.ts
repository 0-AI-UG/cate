import { expect, it, vi } from 'vitest'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { CLIENT_SETTINGS_DOCUMENT, createClientSettingsStore } from './clientSettings'
import { clientSettingsTable } from '../../../shells/desktop/settings'

it('loads the device document over defaults and persists valid edits', async () => {
  const device = createMemoryDeviceStore({ [CLIENT_SETTINGS_DOCUMENT]: { uiScale: 1.2, zoomSpeed: 99 } })
  const store = createClientSettingsStore(device, clientSettingsTable)
  expect(store.get('uiScale')).toBe(clientSettingsTable.defaults.uiScale)
  await store.load()
  expect(store.get('uiScale')).toBe(1.2)
  expect(store.get('zoomSpeed')).toBe(1)

  const cb = vi.fn()
  store.subscribe(cb)
  expect(store.set('editorFontSize', 14)).toBe(true)
  expect(store.set('editorFontSize', 100)).toBe(false)
  expect(cb).toHaveBeenCalledTimes(1)
  expect(cb.mock.calls[0][1]).toEqual({ editorFontSize: 14 })
  await Promise.resolve()
  expect(await device.get(CLIENT_SETTINGS_DOCUMENT)).toMatchObject({ uiScale: 1.2, editorFontSize: 14 })
})

it('follows outside edits of the device document', async () => {
  const device = createMemoryDeviceStore()
  const store = createClientSettingsStore(device, clientSettingsTable)
  await store.load()
  const cb = vi.fn()
  store.subscribe(cb)
  device.change(CLIENT_SETTINGS_DOCUMENT, { snapToGrid: true })
  expect(store.get('snapToGrid')).toBe(true)
  expect(cb.mock.calls[0][1]).toEqual({ snapToGrid: true })
  store.dispose()
})
