// =============================================================================
// Storage reverse-API, end to end with the REAL storage backend (real fs, real
// JSON file under a temp project root) driven through dispatchCateInvoke. This
// is the path the Kitchen Sink notes-autosave and the server CATE_API round-trip
// take. Unlike cateApiHandlers.test.ts (which fakes storage), nothing here mocks
// the store — so it exercises workspace resolution, the exact seam that broke:
// an unknown/empty workspaceId resolves no project root and returns `no-storage`
// (the error the user saw), while a real workspace round-trips set -> get.
// =============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  app: { on: vi.fn() },
  Notification: Object.assign(vi.fn(), { isSupported: () => false }),
}))
vi.mock('./ExtensionManager', () => ({
  extensionManager: { isKnown: () => true, isEnabled: () => true, getManifest: () => ({ id: 'cate.kitchensink', name: 'Kitchen Sink', panels: [], cateApi: ['storage'] }) },
}))
vi.mock('./proxyServer', () => ({ getProxyUrlFor: vi.fn() }))
vi.mock('./ExtensionServerManager', () => ({ extensionServerManager: {} }))
vi.mock('../windowRegistry', () => ({ getActiveMainWindow: vi.fn(() => undefined) }))
vi.mock('../windowPanels', () => ({ getWindowPanels: () => [] }))
vi.mock('../settingsFile', () => ({ getAllSettings: () => ({}) }))
vi.mock('../themeBootCache', () => ({ resolveActiveTheme: () => ({ id: 't', type: 'dark', app: {}, terminal: {} }) }))
vi.mock('../logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// REAL ./storage and REAL parseLocator. Only the workspace lookup is faked, to
// point a known id at a temp project root (and leave unknown ids unresolved).
const getWorkspaceInfo = vi.hoisted(() => vi.fn())
vi.mock('../workspaceManager', () => ({ getWorkspaceInfo }))

import { dispatchCateInvoke, type InvokeScope } from './cateApiHandlers'
// Real storage now routes through the workspace's runtime (local is just another
// daemon), so register the in-process LOCAL runtime; its file ops hit the real fs
// under the temp project root (os.tmpdir() is always an allowed root).
import { registerTestLocalRuntime } from '../runtime/testLocalRuntime'

const EXT = 'cate.kitchensink'
let projectRoot: string

function scope(workspaceId: string, panelId: string | undefined = 'panel-1'): InvokeScope {
  return { extensionId: EXT, workspaceId, panelId, forward: vi.fn() }
}

beforeAll(() => {
  projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cate-ks-storage-')))
  registerTestLocalRuntime()
})

afterAll(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

beforeEach(() => {
  // restoreMocks resets the implementation after each test, so (re)install it here.
  getWorkspaceInfo.mockImplementation((id: string) => (id === 'ws-real' ? { rootPath: projectRoot } : undefined))
  // Clear any persisted file between tests so keys() assertions are deterministic.
  const dir = path.join(projectRoot, '.cate', 'extensions', EXT)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('storage reverse API — real backend, end to end', () => {
  it('round-trips extension-scoped storage for a real workspace (the autosave path)', async () => {
    const s = scope('ws-real')
    expect(await dispatchCateInvoke(s, 'cate.storage.set', { key: 'kitchensink:notes', value: 'hello world' })).toEqual({ ok: true })
    expect(await dispatchCateInvoke(s, 'cate.storage.get', { key: 'kitchensink:notes' })).toBe('hello world')
    expect(await dispatchCateInvoke(s, 'cate.storage.keys', undefined)).toEqual(['kitchensink:notes'])
    expect(await dispatchCateInvoke(s, 'cate.storage.delete', { key: 'kitchensink:notes' })).toEqual({ ok: true })
    expect(await dispatchCateInvoke(s, 'cate.storage.get', { key: 'kitchensink:notes' })).toBeUndefined()
  })

  it('isolates panel-scoped storage to the calling panel', async () => {
    await dispatchCateInvoke(scope('ws-real', 'panel-A'), 'cate.storage.panel.set', { key: 'k', value: 1 })
    expect(await dispatchCateInvoke(scope('ws-real', 'panel-A'), 'cate.storage.panel.get', { key: 'k' })).toBe(1)
    expect(await dispatchCateInvoke(scope('ws-real', 'panel-B'), 'cate.storage.panel.get', { key: 'k' })).toBeUndefined()
    // Panel slices never leak into the extension-scoped key list.
    expect(await dispatchCateInvoke(scope('ws-real'), 'cate.storage.keys', undefined)).not.toContain('k')
  })

  it('persists to <root>/.cate/extensions/<id>/storage.json on disk', async () => {
    await dispatchCateInvoke(scope('ws-real'), 'cate.storage.set', { key: 'persisted', value: 42 })
    const file = path.join(projectRoot, '.cate', 'extensions', EXT, 'storage.json')
    // The write is debounced; poll briefly for the file to materialize on disk.
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20))
    expect(fs.existsSync(file)).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).persisted).toBe(42)
  })

  it('returns no-storage for an unknown workspace (the symptom the user saw)', async () => {
    expect(await dispatchCateInvoke(scope('ghost-ws'), 'cate.storage.get', { key: 'kitchensink:roundtrip' }))
      .toEqual({ error: 'no-storage', method: 'cate.storage.get' })
  })

  it('returns no-storage for an empty workspaceId', async () => {
    expect(await dispatchCateInvoke(scope(''), 'cate.storage.set', { key: 'x', value: 1 }))
      .toEqual({ error: 'no-storage', method: 'cate.storage.set' })
  })
})
