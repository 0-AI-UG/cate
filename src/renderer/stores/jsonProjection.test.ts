import { describe, expect, it, vi } from 'vitest'
import { getElectronAPI, loadOnce, mergeKnown } from './jsonProjection'

describe('JSON projection helpers', () => {
  it('projects only known, defined keys without mutating defaults', () => {
    const defaults = { enabled: false, label: 'default' }
    const stored = { enabled: true, label: undefined, extra: 'ignored' }

    expect(mergeKnown(defaults, stored)).toEqual({ enabled: true })
    expect(defaults).toEqual({ enabled: false, label: 'default' })
  })

  it('shares the same load promise across repeated callers', async () => {
    let finish!: () => void
    const load = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    const once = loadOnce(load)

    const first = once()
    const second = once()
    expect(second).toBe(first)
    expect(load).toHaveBeenCalledTimes(1)

    finish()
    await first
    await once()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reads the preload API when present and returns null without a window', () => {
    const originalWindow = globalThis.window
    const api = { settingsGet: vi.fn() }
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: api } })
    expect(getElectronAPI<typeof api>()).toBe(api)

    Object.defineProperty(globalThis, 'window', { configurable: true, value: undefined })
    expect(getElectronAPI()).toBeNull()
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  })
})
