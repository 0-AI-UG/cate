import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { OnboardingTour } from './OnboardingTour'
import { ONBOARDING_STEPS } from './steps'
import { TELEMETRY_NOTICE_VERSION, UI_STATE_DOCUMENT, createUiStateStore, installUiState, type UiStateStore } from '../state/uiState'
import { useUIStore, INITIAL_UI_STATE } from '../state/uiStore'

let host: HTMLDivElement
let root: Root
let store: UiStateStore
let device: ReturnType<typeof createMemoryDeviceStore>

function clickButton(match: (b: HTMLButtonElement) => boolean): void {
  const btn = [...host.querySelectorAll('button')].find(match)
  if (!btn) throw new Error('button not found')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

beforeEach(async () => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  device = createMemoryDeviceStore({ [UI_STATE_DOCUMENT]: { telemetryNoticeAcknowledgedVersion: TELEMETRY_NOTICE_VERSION } })
  store = createUiStateStore(device)
  await store.load()
  installUiState(store)
  useUIStore.setState(INITIAL_UI_STATE)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installUiState(null)
})

describe('OnboardingTour', () => {
  it('stays hidden until the welcome notice is acknowledged', () => {
    act(() => store.set('telemetryNoticeAcknowledgedVersion', 0))
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toBe('')
  })

  it('stays hidden until the ui state is loaded', () => {
    installUiState(createUiStateStore(createMemoryDeviceStore()))
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toBe('')
  })

  it('shows the first step, then advances on Next', () => {
    act(() => root.render(<OnboardingTour />))
    expect(host.textContent).toContain(ONBOARDING_STEPS[0].title)
    clickButton((b) => b.textContent?.includes('Next') ?? false)
    expect(host.textContent).toContain(ONBOARDING_STEPS[1].title)
  })

  it('persists completion to the device and dismisses on the final step', async () => {
    act(() => root.render(<OnboardingTour />))
    for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) clickButton((b) => b.textContent?.includes('Next') ?? false)
    clickButton((b) => b.textContent?.includes('Get started') ?? false)
    expect(store.getSnapshot().onboardingCompleted).toBe(true)
    expect(host.textContent).toBe('')
    await Promise.resolve()
    expect(await device.get(UI_STATE_DOCUMENT)).toMatchObject({ onboardingCompleted: true })
  })

  it('skipping persists completion and dismisses', () => {
    act(() => root.render(<OnboardingTour />))
    clickButton((b) => b.getAttribute('aria-label') === 'Skip tour')
    expect(store.getSnapshot().onboardingCompleted).toBe(true)
    expect(host.textContent).toBe('')
  })

  it('opens the command palette for the step that spotlights it and closes it after', () => {
    act(() => root.render(<OnboardingTour />))
    const paletteStep = ONBOARDING_STEPS.findIndex((s) => s.openCommandPalette)
    for (let i = 0; i < paletteStep; i++) clickButton((b) => b.textContent?.includes('Next') ?? false)
    expect(useUIStore.getState().commandPaletteOpen).toBe(true)
    clickButton((b) => b.textContent?.includes('Next') ?? false)
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })

  it('clips the canvas spotlight to the area right of the sidebar', () => {
    const canvas = document.createElement('div')
    canvas.setAttribute('data-canvas-container', '')
    canvas.getBoundingClientRect = () => ({ x: 0, y: 40, width: 1000, height: 800, top: 40, left: 0, right: 1000, bottom: 840 }) as DOMRect
    const sidebar = document.createElement('div')
    sidebar.setAttribute('data-app-sidebar', 'left')
    sidebar.getBoundingClientRect = () => ({ x: 0, y: 40, width: 240, height: 800, top: 40, left: 0, right: 240, bottom: 840 }) as DOMRect
    document.body.append(canvas, sidebar)
    act(() => root.render(<OnboardingTour />))
    const spotlight = host.querySelector('.pointer-events-none') as HTMLElement
    expect(spotlight.style.left).toBe('240px')
    canvas.remove()
    sidebar.remove()
  })
})
