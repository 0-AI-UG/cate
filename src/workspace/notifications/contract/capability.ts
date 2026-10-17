import { defineCapability, stream } from '@kernel/rpc/contract'
import type { NotificationEvent } from './events'

export const notificationsCapability = defineCapability('notifications', {
  methods: {},
  streams: {
    /** Every notification event of the workspace from now on. */
    events: stream<void, NotificationEvent>(),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    notifications: typeof notificationsCapability
  }
}
