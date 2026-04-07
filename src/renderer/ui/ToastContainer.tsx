// =============================================================================
// ToastContainer — Renders in-app notification toasts
// =============================================================================

import { X } from '@phosphor-icons/react'
import { useNotificationStore } from '../stores/notificationStore'
import type { Toast } from '../stores/notificationStore'

const TYPE_COLORS: Record<Toast['type'], string> = {
  info: 'border-white/10',
  success: 'border-emerald-500/40',
  warning: 'border-amber-500/40',
  error: 'border-red-500/40',
}

const TYPE_DOTS: Record<Toast['type'], string> = {
  info: 'bg-white/40',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
}

export function ToastContainer() {
  const toasts = useNotificationStore((s) => s.toasts)
  const dismiss = useNotificationStore((s) => s.dismissToast)
  const executeAction = useNotificationStore((s) => s.executeAction)

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border bg-[#262523] shadow-xl backdrop-blur-sm max-w-[320px] animate-in fade-in slide-in-from-bottom-2 ${TYPE_COLORS[toast.type]} ${toast.action ? 'cursor-pointer hover:bg-[#2d2c2a]' : ''}`}
          onClick={() => {
            if (toast.action) {
              executeAction(toast.action)
              dismiss(toast.id)
            }
          }}
        >
          <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${TYPE_DOTS[toast.type]}`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-white/90 leading-tight">{toast.title}</div>
            <div className="text-xs text-white/50 mt-0.5 leading-snug">{toast.body}</div>
          </div>
          <button
            className="flex-shrink-0 mt-0.5 w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-white/30 hover:text-white/60 transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              dismiss(toast.id)
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
