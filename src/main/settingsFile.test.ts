import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { tmpdir } from 'os'

// settingsFile reads app.getPath('userData'). Point it at a per-test temp dir
// (mutated in beforeEach) so each case starts from a clean userData folder.
const dirRef = { current: tmpdir() }
vi.mock('electron', () => ({
  app: { getPath: () => dirRef.current },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
// chokidar isn't exercised here; stub it so importing the module is cheap.
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

import { DEFAULT_SETTINGS } from '../shared/types'

let counter = 0

// Re-import a fresh copy of the module so its cached state (loaded/current)
// resets between tests.
async function freshModule() {
  vi.resetModules()
  return import('./settingsFile')
}

function settingsPath() {
  return path.join(dirRef.current, 'settings.json')
}

beforeEach(() => {
  dirRef.current = path.join(tmpdir(), `cate-settings-test-${process.pid}-${counter++}`)
  fs.mkdirSync(dirRef.current, { recursive: true })
})

afterEach(() => {
  fs.rmSync(dirRef.current, { recursive: true, force: true })
})

describe('settingsFile', () => {
  it('seeds settings.json with defaults on first run', async () => {
    const m = await freshModule()
    m.loadSettingsSync()
    expect(fs.existsSync(settingsPath())).toBe(true)
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.defaultPanelWidth).toBe(DEFAULT_SETTINGS.defaultPanelWidth)
    expect(m.getSetting('defaultPanelWidth')).toBe(DEFAULT_SETTINGS.defaultPanelWidth)
  })

  it('loads an existing settings.json over defaults', async () => {
    fs.writeFileSync(settingsPath(), JSON.stringify({ terminalScrollback: 9000 }))
    const m = await freshModule()
    m.loadSettingsSync()
    expect(m.getSetting('terminalScrollback')).toBe(9000)
    expect(m.getSetting('showMinimap')).toBe(DEFAULT_SETTINGS.showMinimap)
  })

  it('validates setSetting and persists on sync flush', async () => {
    const m = await freshModule()
    m.loadSettingsSync()

    expect(m.setSetting('warnBeforeQuit', true)).toBe(true)
    // Wrong type is rejected and leaves the value unchanged.
    expect(m.setSetting('warnBeforeQuit', 'nope' as never)).toBe(false)
    expect(m.getSetting('warnBeforeQuit')).toBe(true)

    m.flushPendingWritesSync()
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.warnBeforeQuit).toBe(true)
  })

  it('resets a key back to its default', async () => {
    const m = await freshModule()
    m.loadSettingsSync()
    m.setSetting('editorFontSize', 22)
    expect(m.getSetting('editorFontSize')).toBe(22)
    m.resetSetting('editorFontSize')
    expect(m.getSetting('editorFontSize')).toBe(DEFAULT_SETTINGS.editorFontSize)
  })

  it('ensureSettingsFile creates the file when missing', async () => {
    const m = await freshModule()
    m.loadSettingsSync()
    fs.rmSync(settingsPath(), { force: true })
    const p = await m.ensureSettingsFile()
    expect(p).toBe(settingsPath())
    await expect(fsp.access(p)).resolves.toBeUndefined()
  })

  it('isSettingsKey distinguishes known keys', async () => {
    const m = await freshModule()
    expect(m.isSettingsKey('editorFontSize')).toBe(true)
    expect(m.isSettingsKey('recentProjects')).toBe(false)
  })

  it('quarantines a corrupt settings.json and falls back to defaults', async () => {
    fs.writeFileSync(settingsPath(), '{ not valid json,,, ')
    const m = await freshModule()
    m.loadSettingsSync()
    // Corrupt file → defaults, not a crash.
    expect(m.getSetting('editorFontSize')).toBe(DEFAULT_SETTINGS.editorFontSize)
    // The corrupt file is preserved as a .corrupt-* backup for recovery.
    const backups = fs.readdirSync(dirRef.current).filter((f) => f.startsWith('settings.json.corrupt-'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    expect(fs.readFileSync(path.join(dirRef.current, backups[0]), 'utf-8')).toContain('not valid json')
  })

  it('round-trips the beta-updates opt-in (defaults off)', async () => {
    const m = await freshModule()
    m.loadSettingsSync()
    expect(m.isSettingsKey('betaUpdatesEnabled')).toBe(true)
    expect(m.getSetting('betaUpdatesEnabled')).toBe(DEFAULT_SETTINGS.betaUpdatesEnabled)
    expect(DEFAULT_SETTINGS.betaUpdatesEnabled).toBe(false)

    expect(m.setSetting('betaUpdatesEnabled', true)).toBe(true)
    expect(m.getSetting('betaUpdatesEnabled')).toBe(true)
    m.flushPendingWritesSync()
    const onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8'))
    expect(onDisk.betaUpdatesEnabled).toBe(true)
  })
})
