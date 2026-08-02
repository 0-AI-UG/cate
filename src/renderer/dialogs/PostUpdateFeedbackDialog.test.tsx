// =============================================================================
// PostUpdateFeedbackDialog — post-update changelog + rating dialog. It must wait
// for the telemetry notice (WelcomeDialog) to be acknowledged before it appears,
// so on an update the notice goes first and the post-update dialog isn't mounted
// (and running its GitHub fetch) behind the opaque notice. Mirrors the gating
// the OnboardingTour already uses.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

import { PostUpdateFeedbackDialog } from './PostUpdateFeedbackDialog'
import { useSettingsStore } from '../stores/settingsStore'
import { TELEMETRY_NOTICE_VERSION } from '../../shared/types'

let host: HTMLDivElement
let root: Root
let promptCallback: ((p: { fromVersion: string; toVersion: string }) => void) | null = null
const openExternalUrl = vi.fn()

function firePrompt(p: { fromVersion: string; toVersion: string }): void {
  if (!promptCallback) throw new Error('onFeedbackPrompt was never subscribed')
  act(() => { promptCallback!(p) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  promptCallback = null
  openExternalUrl.mockClear()
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    onFeedbackPrompt: (cb: (p: { fromVersion: string; toVersion: string }) => void) => {
      promptCallback = cb
      return () => { promptCallback = null }
    },
    getPendingFeedback: vi.fn(() => Promise.resolve(null)),
    submitFeedback: vi.fn(() => Promise.resolve({ ok: true })),
    dismissFeedback: vi.fn(),
    trackLinkClick: vi.fn(),
    openExternalUrl,
  }
  // The dialog fetches the GitHub star count once visible; stub it so the effect
  // never hits the network in jsdom.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve({}) })))
  useSettingsStore.setState({ _loaded: true, telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PostUpdateFeedbackDialog', () => {
  it('stays hidden while the telemetry notice is unacknowledged, even with a pending prompt', () => {
    useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: 0 } as never)
    act(() => root.render(<PostUpdateFeedbackDialog />))
    firePrompt({ fromVersion: '1.2.0', toVersion: '1.3.0' })
    expect(host.textContent).toBe('')
  })

  it('appears once the notice is acknowledged (notice goes first)', () => {
    useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: 0 } as never)
    act(() => root.render(<PostUpdateFeedbackDialog />))
    firePrompt({ fromVersion: '1.2.0', toVersion: '1.3.0' })
    expect(host.textContent).toBe('')
    // The notice's acknowledgement flips the setting — the post-update dialog,
    // already holding the pending prompt, then reveals itself.
    act(() => { useSettingsStore.setState({ telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION } as never) })
    expect(host.textContent).toContain('Rate this update')
  })

  it('shows the post-update dialog when the notice is already acknowledged', () => {
    act(() => root.render(<PostUpdateFeedbackDialog />))
    firePrompt({ fromVersion: '1.2.0', toVersion: '1.3.0' })
    expect(host.textContent).toContain('Rate this update')
  })

  it('shows the matching detailed release notes and links to the full changelog', () => {
    act(() => root.render(<PostUpdateFeedbackDialog />))
    firePrompt({ fromVersion: '1.6.0-beta.2', toVersion: '1.6.0-beta.3' })

    expect(host.textContent).toContain('Browser automation controls')
    expect(host.textContent).toContain('Remote workspace path validation')

    const link = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Full changelog'))
    if (!link) throw new Error('Full changelog button not found')
    act(() => { link.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(openExternalUrl).toHaveBeenCalledWith(
      'https://github.com/0-AI-UG/cate/blob/main/CHANGELOG.md',
    )
  })
})
