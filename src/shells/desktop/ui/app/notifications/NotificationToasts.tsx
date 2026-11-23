import { useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { toasts as defaultStore, type Toast, type ToastStore } from './toasts'

const LEVEL_BAR: Record<Toast['level'], string> = {
  info: 'bg-focus-blue',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
}

/** The in-app toast stack. Clicking a toast runs its action and dismisses it. */
export function NotificationToasts({ store = defaultStore }: { store?: ToastStore }) {
  const items = useSyncExternalStore(store.subscribe, store.getSnapshot)
  if (items.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100004] flex w-80 max-w-[calc(100vw-32px)] flex-col gap-2" aria-live="polite">
      {items.map((toast) => (
        <div
          key={toast.id}
          role="status"
          data-toast-id={toast.id}
          className="pointer-events-auto flex overflow-hidden rounded-lg border border-subtle bg-surface-2 shadow-lg"
        >
          <span className={`w-1 shrink-0 ${LEVEL_BAR[toast.level]}`} />
          <button
            type="button"
            className="min-w-0 flex-1 px-3 py-2 text-left disabled:cursor-default"
            disabled={!toast.onClick}
            onClick={() => {
              toast.onClick?.()
              store.dismiss(toast.id)
            }}
          >
            <span className="block truncate text-[13px] font-medium text-primary">{toast.title}</span>
            {toast.body && <span className="mt-0.5 line-clamp-3 block text-xs text-secondary">{toast.body}</span>}
          </button>
          <button
            type="button"
            aria-label="Dismiss"
            className="shrink-0 px-2 text-muted hover:text-primary"
            onClick={() => store.dismiss(toast.id)}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
