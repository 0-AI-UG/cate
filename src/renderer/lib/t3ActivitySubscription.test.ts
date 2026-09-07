// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { subscribeT3Activity } from './t3ActivitySubscription'
import { useT3ActivityStore } from '../stores/t3ActivityStore'

afterEach(() => { vi.useRealTimers(); useT3ActivityStore.setState({ panels: {}, instances: {} }) })

it('shares polling, hands off on owner close, and ignores late responses', async () => {
  vi.useFakeTimers()
  const snapshot = { connected: true, revision: 1, sequence: 1, threads: { a: { id: 'a', title: 'A' } } }
  const guests = [0, 1].map(() => ({ executeJavaScript: vi.fn(async () => snapshot) }))
  const callbacks = [vi.fn(), vi.fn()]
  const subscriptions = guests.map((guest, index) => {
    const panelId = String(index)
    useT3ActivityStore.getState().bind(panelId, { workspaceId: 'ws', partition: 'repo' })
    return subscribeT3Activity('repo', { panelId, guest, onSnapshot: callbacks[index] })
  })
  try {
    await vi.advanceTimersByTimeAsync(2000)
    expect(guests[0].executeJavaScript).toHaveBeenCalledTimes(3)
    expect(guests[1].executeJavaScript).not.toHaveBeenCalled()
    expect(callbacks.every((callback) => callback.mock.calls.length > 0)).toBe(true)
    let release!: (value: typeof snapshot) => void
    guests[0].executeJavaScript.mockImplementation((script?: string) => script?.startsWith('/* cate-t3-poll */')
      ? new Promise((resolve) => { release = resolve }) : Promise.resolve(snapshot))
    await vi.advanceTimersByTimeAsync(1000)
    subscriptions[0]()
    await vi.advanceTimersByTimeAsync(0)
    expect(guests[1].executeJavaScript).toHaveBeenCalledOnce()
    release({ ...snapshot, sequence: 99, threads: { a: { id: 'a', title: 'Late' } } })
    await vi.advanceTimersByTimeAsync(0)
    expect(useT3ActivityStore.getState().instances.repo.threads.a.title).toBe('A')
  } finally { subscriptions.forEach((stop) => stop()) }
})

it('does not spin when every guest fails', async () => {
  vi.useFakeTimers()
  const stops = [0, 1].map((index) => {
    const panelId = String(index)
    useT3ActivityStore.getState().bind(panelId, { workspaceId: 'ws', partition: 'failure' })
    const guest = { executeJavaScript: vi.fn(async () => { throw new Error('offline') }) }
    return { guest, stop: subscribeT3Activity('failure', { panelId, guest, onSnapshot: vi.fn() }) }
  })
  try {
    await vi.advanceTimersByTimeAsync(3000)
    expect(stops.reduce((sum, { guest }) => sum + guest.executeJavaScript.mock.calls.length, 0)).toBeLessThanOrEqual(8)
  } finally { stops.forEach(({ stop }) => stop()) }
})
