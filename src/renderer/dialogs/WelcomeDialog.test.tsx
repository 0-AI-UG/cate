// =============================================================================
// WelcomeDialog — first-run welcome + telemetry notice. Shows until the current
// TELEMETRY_NOTICE_VERSION is acknowledged; Continue records the acknowledgement
// (informational only — there is no opt-in/opt-out choice).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { WelcomeDialog } from './WelcomeDialog'
import { useSettingsStore } from '../stores/settingsStore'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'

let host: HTMLDivElement
let root: Root
const acknowledge = vi.fn(() => Promise.resolve())

function clickButton(match: (b: HTMLButtonElement) => boolean): void {
  const btn = [...host.querySelectorAll('button')].find(match as (b: Element) => boolean) as HTMLButtonElement
  if (!btn) throw new Error('button not found')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  acknowledge.mockClear()
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    settingsSet: vi.fn(() => Promise.resolve()),
    acknowledgeTelemetryNotice: acknowledge,
    trackLinkClick: vi.fn(),
    openExternalUrl: vi.fn(),
  }
  useSettingsStore.setState({ _loaded: true, telemetryNoticeAcknowledgedVersion: 0 } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('WelcomeDialog', () => {
  it('is hidden once the current notice version is acknowledged', () => {
    useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION } as never)
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toBe('')
  })

  it('shows for users below the current notice version (fresh install or update)', () => {
    act(() => root.render(<WelcomeDialog />))
    expect(host.textContent).toContain('Welcome to Cate')
    expect(host.textContent).toContain('Privacy Policy')
    // No opt-in choice anymore.
    expect(host.querySelector('[role="switch"]')).toBeNull()
  })

  it('Continue acknowledges the notice and dismisses after the fade', () => {
    vi.useFakeTimers()
    act(() => root.render(<WelcomeDialog />))
    clickButton((b) => b.textContent?.trim() === 'Continue')
    expect(acknowledge).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(350) })
    expect(useSettingsStore.getState().telemetryNoticeAcknowledgedVersion).toBe(TELEMETRY_NOTICE_VERSION)
    vi.useRealTimers()
  })
})
