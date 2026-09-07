// =============================================================================
// NativeAppPanel — the milestone-1c panel that turns a live JPEG stream from
// the (already-tested) main-process NativeAppBroker into a canvas panel. This
// suite covers the renderer wiring only:
//   - no bundleId  -> shows the launcher
//   - picking an app -> persists the choice (via appStore) and, once the panel
//     receives that bundleId back as a prop, acquires a capture session
//   - unmount -> releases the session
// The store module is mocked so this stays a narrow unit test of the panel
// itself rather than an integration test of the whole appStore graph.
// =============================================================================

import React, { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no createImageBitmap — stub it so the frame-drawing effect (not
// exercised by this suite, but present in the module) never throws if a frame
// callback happens to fire.
;(globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = vi.fn(
  async () => ({ width: 100, height: 100, close: vi.fn() }),
)

// Hoisted so the appStore mock factory (evaluated before imports run) can
// route the launcher's store call back into the test harness's React state,
// simulating what PanelHost really does: re-render the panel with the newly
// persisted bundleId once appStore updates.
const h = vi.hoisted(() => ({ onBundleId: null as ((bundleId: string) => void) | null }))

const setPanelNativeAppBundleId = vi.fn((_workspaceId: string, _panelId: string, bundleId: string) => {
  h.onBundleId?.(bundleId)
})

vi.mock('../../stores/appStore', () => ({
  useAppStore: (selector: (s: { setPanelNativeAppBundleId: typeof setPanelNativeAppBundleId }) => unknown) =>
    selector({ setPanelNativeAppBundleId }),
}))

import NativeAppPanel from './NativeAppPanel'

const nativeAppAcquire = vi.fn(async (_opts: { bundleId: string; fps?: number }) => ({ sessionId: 's1' }))
const nativeAppRelease = vi.fn(async (_sessionId: string) => undefined)
const onNativeAppFrame = vi.fn((_cb: (p: { sessionId: string; jpeg: Uint8Array }) => void) => () => {})
const onNativeAppStatus = vi.fn((_cb: (p: { sessionId: string; control: { t: string } }) => void) => () => {})
const nativeAppInput = vi.fn((_sessionId: string, _event: unknown) => undefined)
const nativeAppResize = vi.fn((_sessionId: string, _w: number, _h: number) => undefined)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    nativeAppAcquire,
    nativeAppRelease,
    onNativeAppFrame,
    onNativeAppStatus,
    nativeAppInput,
    nativeAppResize,
  }
  h.onBundleId = null
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

function buttonByText(label: string): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)
  if (!btn) {
    throw new Error(`button "${label}" not found; have: ${Array.from(host.querySelectorAll('button')).map((b) => b.textContent).join(', ')}`)
  }
  return btn as HTMLButtonElement
}

// Mirrors what PanelHost does in the real app: renders NativeAppPanel with
// whatever bundleId is currently persisted on the panel, and re-renders when
// the launcher persists a new one.
function Harness() {
  const [bundleId, setBundleId] = useState<string | undefined>(undefined)
  h.onBundleId = setBundleId
  return <NativeAppPanel panelId="p1" workspaceId="ws1" nativeAppBundleId={bundleId} />
}

describe('NativeAppPanel', () => {
  it('shows the launcher when the panel has no bundleId yet', () => {
    act(() => { root.render(<Harness />) })

    expect(host.textContent).toContain('Capture a native app')
    expect(() => buttonByText('Safari')).not.toThrow()
    expect(nativeAppAcquire).not.toHaveBeenCalled()
  })

  it('acquires a capture session for the bundleId once one is chosen from the launcher', async () => {
    act(() => { root.render(<Harness />) })

    act(() => { buttonByText('Safari').click() })

    expect(setPanelNativeAppBundleId).toHaveBeenCalledWith('ws1', 'p1', 'com.apple.Safari')

    // Let the acquire effect's promise settle.
    await act(async () => { await Promise.resolve() })

    expect(nativeAppAcquire).toHaveBeenCalledTimes(1)
    expect(nativeAppAcquire).toHaveBeenCalledWith({ bundleId: 'com.apple.Safari', fps: 30 })
    // Launcher is gone; the capture canvas has replaced it.
    expect(host.textContent).not.toContain('Capture a native app')
    expect(host.querySelector('canvas')).toBeTruthy()
  })

  it('releases the session on unmount', async () => {
    act(() => { root.render(<NativeAppPanel panelId="p1" workspaceId="ws1" nativeAppBundleId="com.apple.Safari" />) })
    await act(async () => { await Promise.resolve() })

    expect(nativeAppAcquire).toHaveBeenCalledWith({ bundleId: 'com.apple.Safari', fps: 30 })

    act(() => { root.unmount() })
    // Re-mount a throwaway so afterEach's unmount has a live root.
    root = createRoot(host)

    expect(nativeAppRelease).toHaveBeenCalledWith('s1')
  })

  it('accepts a free-typed bundle id', async () => {
    act(() => { root.render(<Harness />) })

    const input = host.querySelector('input') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'com.example.CustomApp')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { buttonByText('Launch').click() })
    // Let the newly-mounted capture view's acquire effect settle before the
    // test tears down, so its state update lands inside act().
    await act(async () => { await Promise.resolve() })

    expect(setPanelNativeAppBundleId).toHaveBeenCalledWith('ws1', 'p1', 'com.example.CustomApp')
  })
})
