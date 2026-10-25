import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLifetime, IDLE_GRACE_MS } from './lifetime'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup(initial: { held?: boolean; clients?: number } = {}) {
  const state = { held: initial.held ?? false, clients: initial.clients ?? 0 }
  const settingsListeners = new Set<() => void>()
  const clientListeners = new Set<() => void>()
  const stop = vi.fn()
  const lifetime = createLifetime({
    held: () => state.held,
    onSettingsChanged: (cb) => { settingsListeners.add(cb); return () => settingsListeners.delete(cb) },
    clients: () => state.clients,
    onClientsChanged: (cb) => { clientListeners.add(cb); return () => clientListeners.delete(cb) },
    stop,
  })
  return {
    state,
    stop,
    lifetime,
    settingsChanged: () => settingsListeners.forEach((cb) => cb()),
    clientsChanged: () => clientListeners.forEach((cb) => cb()),
  }
}

it('stops after the grace period with no client and no work', () => {
  const t = setup()
  vi.advanceTimersByTime(IDLE_GRACE_MS - 1)
  expect(t.stop).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(t.stop).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(IDLE_GRACE_MS * 2)
  expect(t.stop).toHaveBeenCalledTimes(1)
})

it('a client connecting cancels the countdown; leaving restarts it', () => {
  const t = setup()
  vi.advanceTimersByTime(IDLE_GRACE_MS / 2)
  t.state.clients = 1
  t.clientsChanged()
  expect(t.lifetime.counting()).toBe(false)
  vi.advanceTimersByTime(IDLE_GRACE_MS * 2)
  expect(t.stop).not.toHaveBeenCalled()
  t.state.clients = 0
  t.clientsChanged()
  vi.advanceTimersByTime(IDLE_GRACE_MS)
  expect(t.stop).toHaveBeenCalledTimes(1)
})

it('holding keeps it alive, noticed by the poll', () => {
  const t = setup({ clients: 1, held: true })
  t.state.clients = 0
  t.clientsChanged()
  vi.advanceTimersByTime(IDLE_GRACE_MS * 3)
  expect(t.stop).not.toHaveBeenCalled()
  t.state.held = false
  // The next poll starts the countdown.
  vi.advanceTimersByTime(30_000 + IDLE_GRACE_MS)
  expect(t.stop).toHaveBeenCalledTimes(1)
})

it('a hold that starts during the countdown is re-checked before stopping', () => {
  const t = setup()
  vi.advanceTimersByTime(IDLE_GRACE_MS - 10)
  t.state.held = true
  vi.advanceTimersByTime(10)
  expect(t.stop).not.toHaveBeenCalled()
})

it('a settings change re-checks at once', () => {
  const t = setup({ held: true })
  vi.advanceTimersByTime(IDLE_GRACE_MS * 10)
  expect(t.stop).not.toHaveBeenCalled()
  t.state.held = false
  t.settingsChanged()
  vi.advanceTimersByTime(IDLE_GRACE_MS)
  expect(t.stop).toHaveBeenCalledTimes(1)
})
