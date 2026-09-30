;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { KeepAwakeDuration, PowerState } from '@runtime/power/contract/capability'

const h = vi.hoisted(() => ({ power: null as unknown }))
vi.mock('@kernel/rpc/ui', () => ({ useRuntime: () => ({ power: h.power }) }))

import { KeepAwakeButton } from './KeepAwakeButton'

function fakePower() {
  let state: PowerState = { requested: false, endsAt: null, busy: false, holding: false }
  let rev = 0
  const listeners = new Set<(event: unknown) => void>()
  const emit = () => { for (const l of listeners) l({ kind: 'snapshot', rev: ++rev, snapshot: state }) }
  const set = vi.fn(async ({ duration }: { duration: KeepAwakeDuration }) => {
    state = { ...state, requested: duration !== false, endsAt: typeof duration === 'number' ? Date.now() + duration * 60_000 : null }
    emit()
    return state
  })
  return {
    set,
    get: async () => state,
    subscribe: () => ({
      onEvent(listener: (event: unknown) => void) {
        listeners.add(listener)
        queueMicrotask(emit)
        return () => listeners.delete(listener)
      },
      cancel() { listeners.clear() },
    }),
  }
}

it('opens duration choices, starts a timer, and shows remaining time', async () => {
  const originalMatchMedia = window.matchMedia
  const power = fakePower()
  h.power = power
  window.matchMedia = vi.fn(() => ({ matches: true })) as never
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<KeepAwakeButton workspaceId="ws" tooltipPlacement="top" />))
    vi.useFakeTimers()
    const button = host.querySelector('button')!
    act(() => { button.focus(); vi.runAllTimers() })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Keep awake: off')
    await act(async () => button.click())
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(4)
    await act(async () => (document.querySelector('[aria-label="Keep awake for 30m"]') as HTMLButtonElement).click())
    expect(power.set).toHaveBeenCalledWith({ duration: 30 })
    expect(button.textContent).toContain('30m')
    act(() => vi.advanceTimersByTime(60_000))
    expect(button.textContent).toContain('29m')
    await act(async () => button.click())
    await act(async () => (document.querySelector('[aria-label="Keep awake unlimited"]') as HTMLButtonElement).click())
    expect(power.set).toHaveBeenLastCalledWith({ duration: null })
    expect(button.textContent).toContain('∞')
    await act(async () => button.click())
    await act(async () => (Array.from(document.querySelectorAll('button')).find((item) => item.textContent === 'Turn off')!).click())
    expect(power.set).toHaveBeenLastCalledWith({ duration: false })
    expect(button.textContent).not.toContain('∞')
  } finally {
    act(() => root.unmount())
    host.remove()
    window.matchMedia = originalMatchMedia
    vi.useRealTimers()
  }
})
