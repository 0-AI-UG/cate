import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, X } from '@phosphor-icons/react'
import { useNotificationStore } from '../stores/notificationStore'
import type { Notification } from '../stores/notificationStore'

const TYPE_DOTS: Record<Notification['type'], string> = {
  info: 'bg-surface-6',
  success: 'bg-emerald-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
}

export const NotificationBell: React.FC = () => {
  const notifications = useNotificationStore((s) => s.notifications)
  const dismissNotification = useNotificationStore((s) => s.dismissNotification)
  const clearAll = useNotificationStore((s) => s.clearAll)
  const executeAction = useNotificationStore((s) => s.executeAction)
  const [open, setOpen] = useState(false)
  const bellRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })

  // Position the popover below the bell, aligned to its right edge
  useEffect(() => {
    if (!open || !bellRef.current) return
    const rect = bellRef.current.getBoundingClientRect()
    const popoverWidth = 220 // w-66
    const margin = 8
    let left = rect.right - popoverWidth
    if (left + popoverWidth + margin > window.innerWidth) {
      left = window.innerWidth - popoverWidth - margin
    }
    if (left < margin) left = margin
    let top = rect.bottom + 6
    const estHeight = 300
    if (top + estHeight + margin > window.innerHeight) {
      top = Math.max(margin, rect.top - estHeight - 6)
    }
    setPosition({ top, left })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        bellRef.current && !bellRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <>
      <button
        ref={bellRef}
        className="relative text-muted hover:text-primary transition-colors p-1"
        title="Notifications"
        onClick={() => setOpen((v) => !v)}
      >
        <Bell size={16} />
        {notifications.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-blue-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {notifications.length}
          </span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[9999] rounded-md border border-subtle bg-surface-5 backdrop-blur-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150"
          style={{ top: position.top, left: position.left, width: 220 }}
        >
          <div className="px-3 py-2 border-b border-subtle flex items-center justify-between">
            <span className="text-[11px] font-semibold text-primary tracking-wide">Notifications</span>
            {notifications.length > 0 && (
              <button
                className="text-[10px] text-muted hover:text-secondary transition-colors"
                onClick={() => clearAll()}
              >
                Clear all
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="px-3 py-6 text-[11px] text-muted text-center">You're all caught up</div>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`group flex items-start gap-2.5 mx-1 px-2 py-1.5 rounded-md ${n.action ? 'cursor-pointer hover:bg-hover' : ''}`}
                  onClick={() => {
                    if (n.action) executeAction(n.action)
                    dismissNotification(n.id)
                    setOpen(false)
                  }}
                >
                  <div className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${TYPE_DOTS[n.type]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-primary leading-snug truncate">{n.title}</div>
                    <div className="text-[10px] text-muted leading-snug mt-0.5 line-clamp-2">{n.body}</div>
                  </div>
                  <button
                    className="flex-shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-surface-7 text-muted hover:text-secondary transition-opacity"
                    onClick={(e) => { e.stopPropagation(); dismissNotification(n.id) }}
                  >
                    <X size={9} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
