import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { BUILT_IN_BY_ID } from '@kernel/interaction/contract'
import { createDeviceFiles } from './deviceFiles'
import { installThemeBootCache, themeBootFields } from './themeBoot'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('theme boot cache', () => {
  it('follows the OS while the selection is system', () => {
    const dark = themeBootFields({}, true)
    const light = themeBootFields({}, false)
    expect(dark.appearance).toBe('system')
    expect(dark.theme).not.toBe(light.theme)
  })

  it('pins the appearance of an explicit theme', () => {
    const id = Object.keys(BUILT_IN_BY_ID).find((key) => BUILT_IN_BY_ID[key].type === 'light')!
    expect(themeBootFields({ activeThemeId: id }, true)).toMatchObject({ theme: id, appearance: 'light' })
  })

  it('rewrites boot.json when the settings change and applies the native appearance', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-boot-'))
    dirs.push(dir)
    const device = createDeviceFiles(dir)
    const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: true, themeSource: 'system' as 'system' | 'light' | 'dark' })
    installThemeBootCache(device, nativeTheme)
    expect(device.boot().appearance).toBe('system')
    const id = Object.keys(BUILT_IN_BY_ID).find((key) => BUILT_IN_BY_ID[key].type === 'light')!
    device.set('settings', { activeThemeId: id }, { kind: 'renderer', id: 1 })
    expect(device.boot()).toMatchObject({ theme: id, appearance: 'light' })
    expect(device.boot().backgroundColor).toMatch(/^#|^rgb/)
    expect(nativeTheme.themeSource).toBe('light')
    device.dispose()
  })
})
