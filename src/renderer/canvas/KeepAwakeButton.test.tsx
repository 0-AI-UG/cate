;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { KeepAwakeButton } from './KeepAwakeButton'
import { useSettingsStore } from '../stores/settingsStore'
import { storedShortcut } from '../../shared/types'

it('opens duration choices, starts a timer, and shows remaining time', async () => {
  const originalApi = window.electronAPI
  const originalMatchMedia = window.matchMedia
  let changed: (state: { enabled: boolean; endsAt: number | null }) => void = () => {}
  const setKeepAwake = vi.fn(async (duration: 30 | 60 | 300 | null | false) => {
    const state = { enabled: duration !== false, endsAt: typeof duration === 'number' ? Date.now() + duration * 60_000 : null }
    changed(state)
    return state
  })
  window.electronAPI = { ...originalApi,
    getKeepAwake: async () => ({ enabled: false, endsAt: null }), setKeepAwake,
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
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
    await act(async () => (document.querySelector('[aria-label="Keep awake for 30m"]') as HTMLButtonElement).click())
    expect(setKeepAwake).toHaveBeenCalledWith(30)
    expect(button.textContent).toContain('30m')
    act(() => vi.advanceTimersByTime(60_000))
    expect(button.textContent).toContain('29m')
    await act(async () => button.click())
    await act(async () => (document.querySelector('[aria-label="Keep awake unlimited"]') as HTMLButtonElement).click())
    expect(setKeepAwake).toHaveBeenLastCalledWith(null)
    expect(button.textContent).toContain('∞')
    await act(async () => button.click())
    await act(async () => (Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Turn off')!).click())
    expect(setKeepAwake).toHaveBeenLastCalledWith(false)
    expect(button.textContent).not.toContain('∞')
  } finally {
    act(() => root.unmount())
    host.remove()
    useSettingsStore.setState({ customShortcuts: {} })
    window.electronAPI = originalApi
    window.matchMedia = originalMatchMedia
    vi.useRealTimers()
  }
})
