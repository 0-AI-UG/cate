import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isRpcError } from '@kernel/rpc/contract'
import { createSettingsHandlers, createWorkspaceSettingsStore } from './workspaceSettingsStore'
import { workspaceSettingsTable } from '@panels/settings'

vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

let dataDir: string
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ws-settings-')) })
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }))

const readFile = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf-8'))

it('seeds defaults, sets one key and persists it', async () => {
  const store = createWorkspaceSettingsStore({ dataDir, table: workspaceSettingsTable })
  expect(readFile()).toEqual(workspaceSettingsTable.defaults)
  store.set('runtimeLifetime', 'keepRunning')
  expect(store.get('runtimeLifetime')).toBe('keepRunning')
  await store.flushDurable()
  expect(readFile().runtimeLifetime).toBe('keepRunning')
  store.dispose()
  expect(createWorkspaceSettingsStore({ dataDir, table: workspaceSettingsTable }).getAll().runtimeLifetime).toBe('keepRunning')
})

it('refuses unknown keys and invalid values with rejected', () => {
  const store = createWorkspaceSettingsStore({ dataDir, table: workspaceSettingsTable })
  const attempt = (fn: () => void) => { try { fn(); return null } catch (e) { return e } }
  // @ts-expect-error unknown key
  expect(isRpcError(attempt(() => store.set('nope', 1)), 'rejected')).toBe(true)
  // @ts-expect-error wrong type
  expect(isRpcError(attempt(() => store.set('cliEnabled', 'yes')), 'rejected')).toBe(true)
  expect(store.get('cliEnabled')).toBe(true)
  store.dispose()
})

it('drops invalid keys from a hand-edited file', () => {
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ terminalScrollback: 5, browserHomepage: 'https://x.dev', junk: 1 }))
  const store = createWorkspaceSettingsStore({ dataDir, table: workspaceSettingsTable })
  expect(store.get('terminalScrollback')).toBe(2000)
  expect(store.get('browserHomepage')).toBe('https://x.dev')
  store.dispose()
})

it('handlers emit a snapshot, then each edit as a patch', () => {
  const store = createWorkspaceSettingsStore({ dataDir, table: workspaceSettingsTable })
  const handlers = createSettingsHandlers(store)
  const events: unknown[] = []
  const stop = handlers.subscribe((e) => events.push(e))
  handlers.set({ key: 'runtimeNetwork', value: 'sameNetwork' })
  handlers.set({ key: 'runtimeNetwork', value: 'sameNetwork' })
  handlers.set({ key: 'panelRelationsEnabled', value: false })
  stop()
  expect(events[0]).toMatchObject({ kind: 'snapshot', rev: 0 })
  expect(events.slice(1)).toEqual([
    { kind: 'change', rev: 1, change: { runtimeNetwork: 'sameNetwork' } },
    { kind: 'change', rev: 2, change: { panelRelationsEnabled: false } },
  ])
  expect(handlers.getAll().runtimeNetwork).toBe('sameNetwork')
  store.dispose()
})
