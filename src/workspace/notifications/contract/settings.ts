import { defineSettings, setting } from '@kernel/settings/contract'

/** Whether this client shows notifications, every client alike. */
export const notificationSettings = defineSettings({
  scope: 'client',
  keys: {
    notificationsEnabled: setting(true),
    notifyOnlyWhenUnfocused: setting(true),
  },
})
