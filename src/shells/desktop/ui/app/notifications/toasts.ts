// In-app toasts: how a client without `osNotifications` shows a notification.

export interface Toast {
  id: number
  title: string
  body: string
  level: 'info' | 'warning' | 'error'
  onClick?: () => void
}

export interface ToastStore {
  getSnapshot(): readonly Toast[]
  subscribe(listener: () => void): () => void
  show(toast: Omit<Toast, 'id' | 'level'> & { level?: Toast['level'] }): number
  dismiss(id: number): void
}

const TOAST_LIFETIME_MS = 8_000
const MAX_TOASTS = 4

export function createToastStore(lifetimeMs = TOAST_LIFETIME_MS): ToastStore {
  let toasts: readonly Toast[] = []
  let nextId = 1
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  const listeners = new Set<() => void>()

  const set = (next: readonly Toast[]) => {
    toasts = next
    for (const listener of [...listeners]) {
      try { listener() } catch { /* isolate listeners */ }
    }
  }

  const dismiss = (id: number) => {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
    if (toasts.some((t) => t.id === id)) set(toasts.filter((t) => t.id !== id))
  }

  return {
    getSnapshot: () => toasts,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    show(toast) {
      const id = nextId++
      const next = [...toasts, { level: 'info' as const, ...toast, id }]
      for (const dropped of next.slice(0, Math.max(0, next.length - MAX_TOASTS))) {
        const timer = timers.get(dropped.id)
        if (timer) clearTimeout(timer)
        timers.delete(dropped.id)
      }
      set(next.slice(-MAX_TOASTS))
      timers.set(id, setTimeout(() => dismiss(id), lifetimeMs))
      return id
    },
    dismiss,
  }
}

/** The client's toasts, rendered by `NotificationToasts`. */
export const toasts: ToastStore = createToastStore()
