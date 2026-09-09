;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { KeepAwakeButton } from './KeepAwakeButton'
import { useSettingsStore } from '../stores/settingsStore'
import { storedShortcut } from '../../shared/types'

it('shows the actual binding and toggles the shared power state', async () => {
  const originalApi = window.electronAPI
  const originalMatchMedia = window.matchMedia
  let changed: (enabled: boolean) => void = () => {}
  const toggle = vi.fn(async () => { changed(true); return true })
  window.electronAPI = { ...originalApi,
    getKeepAwake: async () => false, toggleKeepAwake: toggle,
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
    expect(toggle).toHaveBeenCalledOnce()
    expect(button.getAttribute('aria-checked')).toBe('true')
  } finally {
    act(() => root.unmount())
    host.remove()
    useSettingsStore.setState({ customShortcuts: {} })
    window.electronAPI = originalApi
    window.matchMedia = originalMatchMedia
    vi.useRealTimers()
  }
})
