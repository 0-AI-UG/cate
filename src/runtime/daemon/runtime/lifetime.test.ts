import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeLifetime, RuntimeNetwork } from '../contract'
import { createBusyRegistry } from './busy'
import { createLifetime, IDLE_GRACE_MS } from './lifetime'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function setup(initial: { lifetime?: RuntimeLifetime; network?: RuntimeNetwork; clients?: number } = {}) {
  const state = { lifetime: initial.lifetime ?? 'stopWhenIdle', network: initial.network ?? 'off', clients: initial.clients ?? 0 }
  const settingsListeners = new Set<() => void>()
  const clientListeners = new Set<() => void>()
  const busy = createBusyRegistry()
  const stop = vi.fn()
  const lifetime = createLifetime({
    settings: {
      runtimeLifetime: () => state.lifetime as RuntimeLifetime,
      runtimeNetwork: () => state.network as RuntimeNetwork,
      subscribe: (cb) => { settingsListeners.add(cb); return () => settingsListeners.delete(cb) },
    },
    busy: busy.busy,
    clients: () => state.clients,
    onClientsChanged: (cb) => { clientListeners.add(cb); return () => clientListeners.delete(cb) },
    stop,
  })
  return {
    state,
    busy,
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

it('running work keeps it alive, noticed by the poll', () => {
  const t = setup({ clients: 1 })
  let working = true
  t.busy.contribute(() => working)
  t.state.clients = 0
  t.clientsChanged()
  vi.advanceTimersByTime(IDLE_GRACE_MS * 3)
  expect(t.stop).not.toHaveBeenCalled()
  working = false
  // The next poll starts the countdown.
  vi.advanceTimersByTime(30_000 + IDLE_GRACE_MS)
  expect(t.stop).toHaveBeenCalledTimes(1)
})

it('work that starts during the countdown is re-checked before stopping', () => {
  const t = setup()
  let working = false
  t.busy.contribute(() => working)
  vi.advanceTimersByTime(IDLE_GRACE_MS - 10)
  working = true
  vi.advanceTimersByTime(10)
  expect(t.stop).not.toHaveBeenCalled()
})

it('keepRunning and network access never stop', () => {
  const keep = setup({ lifetime: 'keepRunning' })
  const network = setup({ network: 'sameNetwork' })
  vi.advanceTimersByTime(IDLE_GRACE_MS * 10)
  expect(keep.stop).not.toHaveBeenCalled()
  expect(network.stop).not.toHaveBeenCalled()

  keep.state.lifetime = 'stopWhenIdle'
  keep.settingsChanged()
  vi.advanceTimersByTime(IDLE_GRACE_MS)
  expect(keep.stop).toHaveBeenCalledTimes(1)
})
