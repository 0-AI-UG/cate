// =============================================================================
// workspaceStateStore — one-time migration of the legacy electron-store
// config.json into the four discrete state files, and its idempotency.
// =============================================================================

import { afterAll, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-wsstate-test-'))
const cfgPath = path.join(userData, 'config.json')

vi.mock('electron', () => {
  const electron = { app: { getPath: () => userData } }
  return { ...electron, default: electron }
})
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

const store = await import('./workspaceStateStore')

const readJson = (name: string) => JSON.parse(fs.readFileSync(path.join(userData, name), 'utf-8'))

afterAll(() => { try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ } })

describe('migrateLegacyConfig', () => {
  test('migrates all four keys into discrete files and deletes config.json', () => {
    fs.writeFileSync(cfgPath, JSON.stringify({
      // a settings key that should be ignored by this migration
      editorFontSize: 16,
      recentProjects: ['/a', '/b'],
      sidebarSession: { order: ['/a', '/b'], selected: '/b' },
      remoteProjects: [{ locator: 'cate-companion://x', connection: {}, snapshot: {} }],
      layouts: { focus: { foo: 1 } },
    }))

    store.migrateLegacyConfig()

    expect(readJson('recent-projects.json')).toEqual({ projects: ['/a', '/b'] })
    expect(readJson('sidebar.json')).toEqual({ session: { order: ['/a', '/b'], selected: '/b' } })
    expect(readJson('remote-workspaces.json').workspaces).toHaveLength(1)
    expect(readJson('layouts.json')).toEqual({ layouts: { focus: { foo: 1 } } })

    // config.json is removed so the migration never runs again.
    expect(fs.existsSync(cfgPath)).toBe(false)

    // Accessors reflect the migrated state.
    expect(store.getRecentProjects()).toEqual(['/a', '/b'])
    expect(store.getSidebarSession()).toEqual({ order: ['/a', '/b'], selected: '/b' })
    expect(store.listLayoutNames()).toEqual(['focus'])
  })

  test('is a no-op when config.json is absent', () => {
    expect(fs.existsSync(cfgPath)).toBe(false)
    expect(() => store.migrateLegacyConfig()).not.toThrow()
    expect(store.getRecentProjects()).toEqual(['/a', '/b'])
  })

  test('does not clobber existing files if a stale config.json reappears', () => {
    // A new config.json shows up (e.g. a downgrade/upgrade dance) but the new
    // files already exist — their values must win, and config.json is removed.
    fs.writeFileSync(cfgPath, JSON.stringify({ recentProjects: ['/should-not-win'] }))
    store.migrateLegacyConfig()
    expect(readJson('recent-projects.json')).toEqual({ projects: ['/a', '/b'] })
    expect(fs.existsSync(cfgPath)).toBe(false)
  })
})
