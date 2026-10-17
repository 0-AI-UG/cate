import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createClientSettingsStore } from '@kernel/settings/client'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { installMockClientUi } from '../../../../test/clientUi'
import { clientSettingsTable } from '../../settings'
import { getClientSetting, installClientSettings } from '../kernel/settings'

const h = vi.hoisted(() => ({ openLink: vi.fn(async () => true) }))
vi.mock('@client/host', () => ({ openLink: h.openLink }))
import { openClickedLink } from './links'

const url = { kind: 'url', url: 'https://example.com' } as const

beforeEach(() => installClientSettings(createClientSettingsStore(createMemoryDeviceStore(), clientSettingsTable)))
afterEach(() => {
  installClientSettings(null)
  h.openLink.mockClear()
})

it('asks where a web link opens the first time and remembers the answer', async () => {
  const ui = installMockClientUi({ promptLinkOpen: vi.fn(async () => 'external' as const) })
  await openClickedLink('w', url, { from: 't1' })
  await openClickedLink('w', url, { from: 't1' })
  expect(ui.promptLinkOpen).toHaveBeenCalledTimes(1)
  expect(getClientSetting('linkOpenTarget')).toBe('external')
  expect(h.openLink.mock.calls).toEqual([['w', url, { from: 't1', external: true }], ['w', url, { from: 't1', external: true }]])
})

it('opens nothing when the person cancels, and never asks for loopback, files or Shift', async () => {
  const ui = installMockClientUi({ promptLinkOpen: vi.fn(async () => 'cancel' as const) })
  expect(await openClickedLink('w', url)).toBe(false)
  expect(h.openLink).not.toHaveBeenCalled()
  await openClickedLink('w', { kind: 'url', url: 'http://localhost:3000' })
  await openClickedLink('w', { kind: 'file', path: '/repo/a.ts' })
  await openClickedLink('w', url, { external: true })
  expect(ui.promptLinkOpen).toHaveBeenCalledTimes(1)
  expect(h.openLink).toHaveBeenCalledTimes(3)
  expect(getClientSetting('linkOpenTarget')).toBe('ask')
})
