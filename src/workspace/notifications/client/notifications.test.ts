import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Subscription } from '@kernel/rpc/contract'
import type { NotificationEvent } from '../contract'
import { attachNotifications, type NotificationConnection } from './attach'
import { createNotificationGate } from './gate'

const reader = (read: () => { notificationsEnabled: boolean; notifyOnlyWhenUnfocused: boolean }) => ({ get: <K extends 'notificationsEnabled' | 'notifyOnlyWhenUnfocused'>(key: K) => read()[key] })

function fakeEvents() {
  const listeners = new Set<(event: NotificationEvent) => void>()
  const sub = {
    onEvent: (listener: (event: NotificationEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    done: new Promise(() => {}),
    cancel: vi.fn(),
  } as unknown as Subscription<NotificationEvent, unknown> & { cancel: ReturnType<typeof vi.fn> }
  return { sub, emit: (event: NotificationEvent) => { for (const l of [...listeners]) l(event) } }
}

const event: NotificationEvent = { kind: 'agent.needsInput', panelId: 'p1', title: 't', body: 'b' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

it('hands every event of each open workspace to the client, and detaches', () => {
  const events = fakeEvents()
  const runtime = { notifications: { events: vi.fn(() => events.sub) } }
  const connection: NotificationConnection = { workspaceId: 'ws', runtime }
  let list = [connection]
  const listeners = new Set<() => void>()
  const show = vi.fn()
  const stop = attachNotifications({ getSnapshot: () => list, subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) } }, show)
  expect(runtime.notifications.events).toHaveBeenCalledWith(undefined, { resume: true })
  events.emit(event)
  expect(show).toHaveBeenCalledWith('ws', event)
  list = []
  for (const l of listeners) l()
  expect(events.sub.cancel).toHaveBeenCalled()
  stop()
})

it('shows only what the client\'s settings and focus allow, after a moment, unless cancelled', () => {
  const settings = { notificationsEnabled: true, notifyOnlyWhenUnfocused: true }
  let focused = true
  const show = vi.fn()
  const gate = createNotificationGate({ settings: reader(() => settings), isFocused: () => focused, show })

  // In front with notifyOnlyWhenUnfocused: nothing.
  gate.show('ws', event)
  vi.advanceTimersByTime(1_000)
  expect(show).not.toHaveBeenCalled()

  focused = false
  gate.show('ws', event)
  vi.advanceTimersByTime(1_000)
  expect(show).toHaveBeenCalledWith('ws', event)

  // The agent went back to work before the moment passed.
  gate.show('ws', event)
  gate.cancel('ws', 'p1')
  vi.advanceTimersByTime(1_000)
  expect(show).toHaveBeenCalledTimes(1)
  gate.dispose()
})
