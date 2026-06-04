// =============================================================================
// WelcomeDialog — first-run welcome + consent. Shows only until the choice is
// made; Continue persists the single enable/disable choice to both telemetry
// flags and records the consent decision.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WelcomeDialog } from './WelcomeDialog'
import { useSettingsStore } from '../stores/settingsStore'

let host: HTMLDivElement
let root: Root
const setConsent = vi.fn(() => Promise.resolve())

function clickButton(match: (b: HTMLButtonElement) => boolean): void {
  const btn = [...host.querySelectorAll('button')].find(match as (b: Element) => boolean) as HTMLButtonElement
  if (!btn) throw new Error('button not found')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  setConsent.mockClear()
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    settingsSet: vi.fn(() => Promise.resolve()),
    setTelemetryConsent: setConsent,
    trackLinkClick: vi.fn(),
    openExternalUrl: vi.fn(),
  }
  useSettingsStore.setState({ _loaded: true, telemetryConsentDecided: false } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('WelcomeDialog', () => {
  it('is hidden once a consent choice has been recorded', () => {
    useSettingsStore.setState({ telemetryConsentDecided: true } as never)
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toBe('')
  })

  it('shows the welcome + consent on first run', () => {
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toContain('Welcome to Cate')
    expect(host.textContent).toContain('Star on GitHub')
    expect(host.querySelector('[role="switch"]')).not.toBeNull()
  })

  it('Continue with the default toggle on enables both telemetry flags', () => {
    vi.useFakeTimers()
    act(() => root.render(<WelcomeDialog />))
    clickButton((b) => b.textContent?.trim() === 'Continue')
    // The consent is persisted over IPC immediately…
    expect(setConsent).toHaveBeenCalledWith({ crashReporting: true, usageAnalytics: true })
    // …and the local store reflects it after the fade-out delay.
    act(() => { vi.advanceTimersByTime(350) })
    const s = useSettingsStore.getState()
    expect(s.telemetryConsentDecided).toBe(true)
    expect(s.crashReportingEnabled).toBe(true)
    expect(s.usageAnalyticsEnabled).toBe(true)
    vi.useRealTimers()
  })

  it('toggling Enabled off then Continue declines both flags', () => {
    vi.useFakeTimers()
    act(() => root.render(<WelcomeDialog />))
    clickButton((b) => b.getAttribute('role') === 'switch')
    clickButton((b) => b.textContent?.trim() === 'Continue')
    expect(setConsent).toHaveBeenCalledWith({ crashReporting: false, usageAnalytics: false })
    act(() => { vi.advanceTimersByTime(350) })
    expect(useSettingsStore.getState().usageAnalyticsEnabled).toBe(false)
    vi.useRealTimers()
  })
})
