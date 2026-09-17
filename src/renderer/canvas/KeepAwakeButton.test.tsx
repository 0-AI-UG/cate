;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { KeepAwakeButton } from './KeepAwakeButton'
import { useSettingsStore } from '../stores/settingsStore'
import { storedShortcut } from '../../shared/types'

it('opens a centered duration menu and starts a timed keep-awake session', async () => {
  const originalApi = window.electronAPI
  const originalMatchMedia = window.matchMedia
  let changed: (enabled: boolean, endsAt: number | null) => void = () => {}
  const setKeepAwake = vi.fn(async (_active: boolean, minutes?: number) => { changed(true, minutes ? Date.now() + minutes * 60_000 : null); return true })
  window.electronAPI = { ...originalApi,
    getKeepAwakeStatus: async () => ({ enabled: false, endsAt: null }), setKeepAwake,
    onKeepAwakeChanged: (callback) => { changed = callback; return () => {} },
  }
  window.matchMedia = vi.fn(() => ({ matches: true })) as never
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<KeepAwakeButton tooltipPlacement="top" />))
    vi.useFakeTimers()
    const button = host.querySelector('button')!
    act(() => { button.focus(); vi.runAllTimers() })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Keep awake: off (⌥⌘K)')
    act(() => useSettingsStore.setState({ customShortcuts: { toggleKeepAwake: storedShortcut('j', { command: true, option: true }) } }))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Keep awake: off (⌥⌘J)')
    await act(async () => button.click())
    const menu = document.querySelector('[aria-label="Keep awake duration"]')!
    expect(menu.textContent).toContain('15 min')
    expect(menu.textContent).toContain('60 min')
    expect(menu.textContent).toContain('∞ · Until turned off')
    await act(async () => (Array.from(menu.querySelectorAll('button')).find((item) => item.textContent === '30 min')!).click())
    expect(setKeepAwake).toHaveBeenCalledWith(true, 30)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.textContent).toContain('30')
    act(() => vi.advanceTimersByTime(60_000))
    expect(button.textContent).toContain('29')
    await act(async () => button.click())
    await act(async () => (Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Keep awake duration"] button')).find((item) => item.textContent?.startsWith('∞'))!).click())
    expect(setKeepAwake).toHaveBeenLastCalledWith(true, undefined)
    expect(button.textContent).toContain('∞')
  } finally {
    act(() => root.unmount())
    host.remove()
    useSettingsStore.setState({ customShortcuts: {} })
    window.electronAPI = originalApi
    window.matchMedia = originalMatchMedia
    vi.useRealTimers()
  }
})
