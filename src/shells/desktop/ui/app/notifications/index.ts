// Notification display (architecture 10.5): runtime events, gated by this
// client's settings and focus, shown as OS notifications or in-app toasts.

export { shouldShowNotification, type NotificationSettings } from './gating'
export { createNotificationDebouncer, type NotificationDebouncer } from './debouncer'
export { createToastStore, toasts, type Toast, type ToastStore } from './toasts'
export { NotificationToasts } from './NotificationToasts'
export {
  createNotificationDisplay,
  runNotificationAction,
  onNotificationFocus,
  NOTIFICATION_DEBOUNCE_MS,
  type NotificationDisplay,
  type NotificationDisplayDeps,
  type RuntimeNotification,
} from './display'
export {
  attachNotifications,
  type NotificationConnection,
  type NotificationConnections,
} from './attach'
