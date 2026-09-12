import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import { CanvasSettings } from './CanvasSettings'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CanvasSettings', () => {
  let host: HTMLDivElement
  let root: Root
  let settingsSet: ReturnType<typeof vi.fn>

  beforeEach(() => {
    settingsSet = vi.fn(async () => {})
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { settingsSet },
    })
    useSettingsStore.setState({ ...DEFAULT_SETTINGS, _loaded: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: undefined,
    })
  })

  it('persists the panel-relations master toggle', () => {
    act(() => root.render(<CanvasSettings />))
    const row = [...host.querySelectorAll<HTMLElement>('[data-srow]')].find(
      (candidate) => candidate.querySelector('span')?.textContent === 'Panel relations',
    )
    const toggle = row?.querySelector<HTMLButtonElement>('button[role="switch"]') ?? null
    expect(toggle).not.toBeNull()

    act(() => toggle?.click())

    expect(useSettingsStore.getState().panelRelationsEnabled).toBe(false)
    expect(settingsSet).toHaveBeenCalledWith('panelRelationsEnabled', false)
  })
})
