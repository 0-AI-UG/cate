// The desktop's notification display (architecture 10.5): the events the
// shared consumer (`attachNotifications`) hands it, gated by the core's gate,
// shown as OS notifications or in-app toasts.

export { createToastStore, toasts, type Toast, type ToastStore } from './toasts'
export { NotificationToasts } from './NotificationToasts'
export {
  createNotificationDisplay,
  runNotificationAction,
  onNotificationFocus,
  type NotificationDisplayDeps,
} from './display'
