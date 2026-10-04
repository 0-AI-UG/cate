// The desktop's notification display (architecture 10.5): the events the
// shared consumer (`attachAgentNotifications`) hands it, gated by this
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
  type DesktopNotificationDisplay,
  type NotificationDisplayDeps,
} from './display'
