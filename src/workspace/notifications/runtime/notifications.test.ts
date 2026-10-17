import { expect, it } from 'vitest'
import type { NotificationEvent } from '../contract'
import { createNotifications, notificationsCapabilityImpl } from './notifications'

const event = (body: string): NotificationEvent => ({ kind: 'cate.ui.notify', title: 'Cate', body })

it('replays kept events to a client that subscribes later, then follows live ones', () => {
  const notifications = createNotifications()
  notifications.publish(event('gone'))
  notifications.keep(event('kept'))
  const seen: NotificationEvent[] = []
  const stop = notificationsCapabilityImpl(notifications).events(undefined as never, { emit: (e: NotificationEvent) => seen.push(e) } as never, {} as never)
  notifications.publish(event('live'))
  expect(seen.map((e) => e.body)).toEqual(['kept', 'live'])
  ;(stop as () => void)()
})
