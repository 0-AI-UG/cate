// Whether this client shows a notification, from its own notification
// settings and whether it has the person's attention right now.

export interface NotificationSettings {
  notificationsEnabled: boolean
  notifyOnlyWhenUnfocused: boolean
}

export function shouldShowNotification(settings: NotificationSettings, focused: boolean): boolean {
  if (!settings.notificationsEnabled) return false
  if (settings.notifyOnlyWhenUnfocused && focused) return false
  return true
}
