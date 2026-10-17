import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { KnownRuntimes } from '@runtime/pairing/client'
import { decodeKeyPair, encodePublicKey, generateKeyPair } from '@runtime/security/contract'
import { createDeviceFiles, type DeviceFiles } from './deviceFiles'
import { deviceStoreOf } from './deviceIpc'

const opened: { dir: string; files: DeviceFiles }[] = []
function open(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-device-'))) {
  const files = createDeviceFiles(dir)
  opened.push({ dir, files })
  return { dir, files }
}
afterEach(() => {
  for (const { dir, files } of opened.splice(0)) {
    files.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('device files', () => {
  test('round-trips a shared document through a restart', () => {
    const { dir, files } = open()
    expect(files.get('workspaces')).toBeUndefined()
    files.set('workspaces', { recents: ['local:/a'] })
    files.flushSync()
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'workspaces.json'), 'utf-8'))).toEqual({ recents: ['local:/a'] })
    files.dispose()
    const again = createDeviceFiles(dir)
    expect(again.get('workspaces')).toEqual({ recents: ['local:/a'] })
    again.dispose()
  })

  test('announces sets with their origin', () => {
    const { files } = open()
    const listener = vi.fn()
    files.subscribe(listener)
    files.set('ui-state', { minimap: 'br' }, { kind: 'renderer', id: 4 })
    expect(listener).toHaveBeenCalledWith('ui-state', { minimap: 'br' }, { kind: 'renderer', id: 4 })
  })

  test('a renderer write to boot.json keeps the fields main owns', () => {
    const { files } = open()
    files.updateBoot({ geometry: { x: 1, y: 2, width: 800, height: 600 }, theme: 'dark-cold' })
    files.set('boot', { lastWorkspace: 'local:/w', geometry: { x: 0, y: 0, width: 1, height: 1 } }, { kind: 'renderer', id: 1 })
    expect(files.boot()).toEqual({ lastWorkspace: 'local:/w', geometry: { x: 1, y: 2, width: 800, height: 600 }, theme: 'dark-cold' })
  })

  test('creates the device key once, 0600, and keeps it', () => {
    const { dir, files } = open()
    const keys = files.deviceKeys()
    const file = path.join(dir, 'device-key.json')
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    const stored = decodeKeyPair(JSON.parse(fs.readFileSync(file, 'utf-8')))
    expect(stored?.publicKey).toEqual(keys.publicKey)
    expect(files.devicePublicKey()).toBe(encodePublicKey(keys.publicKey))
    files.dispose()
    const again = createDeviceFiles(dir)
    expect(again.deviceKeys().publicKey).toEqual(keys.publicKey)
    again.dispose()
  })

  test('replaces an unreadable device key', () => {
    const { dir, files } = open()
    fs.writeFileSync(path.join(dir, 'device-key.json'), '{"publicKey":"00","secretKey":"zz"}')
    expect(files.deviceKeys().publicKey).toHaveLength(32)
  })

  test('install id: created once, remembers whether it pre-existed', () => {
    const fresh = open()
    const id = fresh.files.installId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(fresh.files.installIdPreexisted()).toBe(false)
    const reopened = createDeviceFiles(fresh.dir)
    expect(reopened.installId()).toBe(id)
    expect(reopened.installIdPreexisted()).toBe(true)
    reopened.dispose()
  })

  test('the renderer-facing DeviceStore backs KnownRuntimes', async () => {
    const { dir, files } = open()
    const store = deviceStoreOf(files)
    const pins = new KnownRuntimes(store)
    const key = generateKeyPair().publicKey
    await pins.pin('abcdefghijklmnop', key)
    expect(await pins.get('abcdefghijklmnop')).toEqual(key)
    files.flushSync()
    expect(fs.existsSync(path.join(dir, 'known-runtimes.json'))).toBe(true)
    await expect(store.get('device-key.json')).rejects.toThrow()
  })
})
