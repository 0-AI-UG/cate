// =============================================================================
// store.ts — SETTINGS_SET / SETTINGS_RESET broadcast the full settings as
// SETTINGS_RELOADED. AppSettings live in settings.json and the workspace-state
// keys live in their own files (see ./workspaceStateStore). boot.json is backed
// by jsonStateFile (quarantine, merged partial writes, will-quit sync flush).
// =============================================================================

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-store-test-'))
// Seeded before the store module ever loads boot.json: the first boot access
// must quarantine this and fall back to an empty snapshot.
fs.writeFileSync(path.join(userData, 'boot.json'), '{ definitely not json', 'utf-8')

const handlers = new Map<string, (...args: any[]) => any>()
const appListeners = new Map<string, (...args: any[]) => any>()
vi.mock('electron', () => {
  const electron = {
    app: {
      getPath: () => userData,
      getVersion: () => '0.0.0-test',
      getName: () => 'cate-test',
      isPackaged: false,
      on: vi.fn((event: string, fn: any) => appListeners.set(event, fn)),
    },
    ipcMain: { on: vi.fn(), handle: vi.fn((c: string, fn: any) => handlers.set(c, fn)) },
    nativeTheme: { on: vi.fn(), themeSource: 'system' },
    BrowserWindow: { getAllWindows: () => [] },
    shell: {},
  }
  return { ...electron, default: electron }
})
vi.mock('./windowRegistry', () => ({
  broadcastToAll: vi.fn(),
  windowFromEvent: vi.fn(),
  getWindowType: vi.fn(),
}))
vi.mock('./logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))
// settingsFile + jsonStateFile start chokidar watchers; stub it so the test
// doesn't create real filesystem watchers on the temp userData dir.
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

const runtimeSettings = vi.hoisted(() => ({ connected: [] as ((id: string, runtime: unknown) => void)[] }))
vi.mock('./runtime/runtimeManager', () => ({ runtimes: {
  connectedIds: () => [],
  onConnected: (callback: (id: string, runtime: unknown) => void) => { runtimeSettings.connected.push(callback); return () => {} },
} }))

const { registerHandlers, readBootSnapshot, writeBootSnapshot, flushBootSnapshotSync } = await import('./store')
const { SETTINGS_SET, SETTINGS_RESET, SETTINGS_RELOADED } = await import('../shared/ipc-channels')
const { DEFAULT_SETTINGS } = await import('../shared/types')
const { broadcastToAll } = await import('./windowRegistry')
const broadcastMock = broadcastToAll as unknown as ReturnType<typeof vi.fn>

beforeAll(async () => {
  registerHandlers()
})

afterAll(() => {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('SETTINGS_SET / SETTINGS_RESET broadcast', () => {
  test('SETTINGS_SET broadcasts the full settings as SETTINGS_RELOADED', async () => {
    broadcastMock.mockClear()
    const setHandler = handlers.get(SETTINGS_SET)
    expect(setHandler).toBeTypeOf('function')
    await setHandler!({}, 'editorFontSize', 19)

    const reloaded = broadcastMock.mock.calls.find((c: unknown[]) => c[0] === SETTINGS_RELOADED)
    expect(reloaded).toBeTruthy()
    // The funnel broadcasts the complete settings object (a pure projection),
    // reflecting the change just written.
    expect((reloaded![1] as Record<string, unknown>).editorFontSize).toBe(19)
  })

  test('a rejected SETTINGS_SET (wrong type) does not broadcast', async () => {
    broadcastMock.mockClear()
    const setHandler = handlers.get(SETTINGS_SET)
    await setHandler!({}, 'editorFontSize', 'not-a-number')
    expect(broadcastMock.mock.calls.some((c: unknown[]) => c[0] === SETTINGS_RELOADED)).toBe(false)
  })

  test('SETTINGS_RESET broadcasts the full settings as SETTINGS_RELOADED', async () => {
    broadcastMock.mockClear()
    const resetHandler = handlers.get(SETTINGS_RESET)
    expect(resetHandler).toBeTypeOf('function')
    await resetHandler!({}, 'editorFontSize')

    const reloaded = broadcastMock.mock.calls.find((c: unknown[]) => c[0] === SETTINGS_RELOADED)
    expect(reloaded).toBeTruthy()
    expect((reloaded![1] as Record<string, unknown>).editorFontSize).toBe(DEFAULT_SETTINGS.editorFontSize)
  })
})

describe('boot snapshot (boot.json via jsonStateFile)', () => {
  const bootPath = path.join(userData, 'boot.json')
  const readDisk = (): Record<string, unknown> => JSON.parse(fs.readFileSync(bootPath, 'utf-8'))

  test('a corrupt boot.json is quarantined at first load and reads as empty', () => {
    // The module-scope seed above was unparseable; the first boot access (here
    // or during a settings test's theme-cache rebuild) must not throw and must
    // preserve the broken content aside as boot.json.corrupt-<ts>.
    expect(readBootSnapshot()).toBeTypeOf('object')
    const quarantined = fs.readdirSync(userData).filter((f) => f.startsWith('boot.json.corrupt-'))
    expect(quarantined.length).toBe(1)
    expect(fs.readFileSync(path.join(userData, quarantined[0]), 'utf-8')).toBe('{ definitely not json')
  })

  test('writeBootSnapshot merges partials from several writers into one file', () => {
    writeBootSnapshot({ geometry: { x: 1, y: 2, width: 300, height: 200 } })
    writeBootSnapshot({ lastWorkspaceId: 'ws-1' })
    flushBootSnapshotSync()
    const onDisk = readDisk()
    expect(onDisk.geometry).toEqual({ x: 1, y: 2, width: 300, height: 200 })
    expect(onDisk.lastWorkspaceId).toBe('ws-1')
    expect(readBootSnapshot().lastWorkspaceId).toBe('ws-1')
  })

  test('the will-quit hook flushes a pending debounced write synchronously', () => {
    // registerHandlers registered the app-level will-quit flush. A write inside
    // the debounce window must land on disk when the hook runs (previously the
    // 250ms hand-rolled debounce simply lost it on quit).
    const willQuit = appListeners.get('will-quit')
    expect(willQuit).toBeTypeOf('function')
    writeBootSnapshot({ lastWorkspaceId: 'ws-quit' })
    willQuit!()
    expect(readDisk().lastWorkspaceId).toBe('ws-quit')
  })
})


describe('live theme background', () => {
  test.each([
    ['darwin', 'main', '#00000000'],
    ['darwin', 'dock', '#123456'],
    ['win32', 'main', '#123456'],
    ['linux', 'main', '#123456'],
  ] as const)('preserves the correct backing for %s %s windows', async (platform, type, expected) => {
    const { windowFromEvent, getWindowType } = await import('./windowRegistry')
    const { BOOT_SNAPSHOT_WRITE } = await import('../shared/ipc-channels')
    const setBackgroundColor = vi.fn()
    vi.mocked(windowFromEvent).mockReturnValue({ id: 1, setBackgroundColor } as any)
    vi.mocked(getWindowType).mockReturnValue(type)
    vi.stubEnv('CATE_FAKE_PLATFORM', platform)
    try {
      await handlers.get(BOOT_SNAPSHOT_WRITE)!({}, { backgroundColor: '#123456' })
      expect(setBackgroundColor).toHaveBeenCalledWith(expected)
      expect(readBootSnapshot()?.backgroundColor).toBe('#123456')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

test('newly connected runtimes receive current settings changed while disconnected', async () => {
  await handlers.get(SETTINGS_SET)!({}, 'fileExclusions', ['new-exclusion'])
  await handlers.get(SETTINGS_SET)!({}, 'autoSuspendIdleTerminals', false)
  const runtime = { setExclusions: vi.fn().mockResolvedValue(undefined), setIdleSuspend: vi.fn().mockResolvedValue(undefined) }
  runtimeSettings.connected.forEach(notify => notify('local', runtime))
  await Promise.resolve()
  expect(runtime.setExclusions).toHaveBeenCalledWith(['new-exclusion'])
  expect(runtime.setIdleSuspend).toHaveBeenCalledWith(false)
})
