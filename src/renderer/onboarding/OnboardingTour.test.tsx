// =============================================================================
// OnboardingTour flow — shows only after consent is decided and not yet
// completed, advances through the steps, and persists completion when finished
// or skipped (which dismisses it).
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

vi.mock('../lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OnboardingTour } from './OnboardingTour'
import { ONBOARDING_STEPS } from './steps'
import { useSettingsStore } from '../stores/settingsStore'

let host: HTMLDivElement
let root: Root

function setState(partial: Record<string, unknown>): void {
  act(() => { useSettingsStore.setState(partial as never) })
}

function clickButton(match: (b: HTMLButtonElement) => boolean): void {
  const btn = [...host.querySelectorAll('button')].find(match as (b: Element) => boolean) as HTMLButtonElement
  if (!btn) throw new Error('button not found')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // The settings store's setSetting fires settingsSet over IPC, and the tour
  // reports usage — stub both so the real store action doesn't throw in jsdom.
  ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI = {
    ...(window as unknown as { electronAPI?: Record<string, unknown> }).electronAPI,
    settingsSet: vi.fn(() => Promise.resolve()),
    trackFeatureUsed: vi.fn(),
  }
  // Fresh, consented, not-yet-onboarded state.
  useSettingsStore.setState({ _loaded: true, telemetryConsentDecided: true, onboardingCompleted: false } as never)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('OnboardingTour', () => {
  it('stays hidden until the telemetry consent choice is made', () => {
    setState({ telemetryConsentDecided: false })
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toBe('')
  })

  it('shows the first step once consent is decided and not completed', () => {
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toContain(ONBOARDING_STEPS[0].title)
  })

  it('advances to the next step on Next', () => {
    act(() => root.render(<OnboardingTour />))
    clickButton((b) => b.textContent?.includes('Next') ?? false)
    expect(host.textContent).toContain(ONBOARDING_STEPS[1].title)
  })

  it('persists completion and dismisses on the final step', () => {
    act(() => root.render(<OnboardingTour />))
    // Click Next until the final "Get started" button, then finish.
    for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) {
      clickButton((b) => b.textContent?.includes('Next') ?? false)
    }
    clickButton((b) => b.textContent?.includes('Get started') ?? false)
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true)
    expect(host.textContent).toBe('')
  })

  it('skipping (the X) persists completion and dismisses', () => {
    act(() => root.render(<OnboardingTour />))
    clickButton((b) => b.getAttribute('aria-label') === 'Skip tour')
    expect(useSettingsStore.getState().onboardingCompleted).toBe(true)
    expect(host.textContent).toBe('')
  })

  it('clips the canvas spotlight to the visible area between the sidebars', () => {
    // The canvas element spans edge-to-edge under the translucent sidebars; the
    // spotlight must inset by the left sidebar so it doesn't highlight (or place
    // its card) behind it. Stub the geometry jsdom doesn't compute.
    const canvas = document.createElement('div')
    canvas.setAttribute('data-canvas-container', '')
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 40, width: 1000, height: 800, top: 40, left: 0, right: 1000, bottom: 840 }) as DOMRect
    const sidebar = document.createElement('div')
    sidebar.setAttribute('data-app-sidebar', 'left')
    sidebar.getBoundingClientRect = () =>
      ({ x: 0, y: 40, width: 240, height: 800, top: 40, left: 0, right: 240, bottom: 840 }) as DOMRect
    document.body.append(canvas, sidebar)

    act(() => root.render(<OnboardingTour />))

    const spotlight = host.querySelector('.pointer-events-none') as HTMLElement
    expect(spotlight).not.toBeNull()
    // The full-canvas highlight hugs the edge (no outward pad), so the left edge
    // sits exactly at the sidebar's right edge (240).
    expect(spotlight.style.left).toBe('240px')

    canvas.remove()
    sidebar.remove()
  })
})
