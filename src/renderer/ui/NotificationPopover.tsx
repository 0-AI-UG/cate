import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bell, X } from '@phosphor-icons/react'
import { useNotificationStore } from '../stores/notificationStore'
import type { Notification } from '../stores/notificationStore'

const TYPE_DOTS: Record<Notification['type'], string> = {
  info: 'bg-white/40',
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

  // Position the popover next to the bell
  useEffect(() => {
    if (!open || !bellRef.current) return
    const rect = bellRef.current.getBoundingClientRect()
    setPosition({ top: rect.top, left: rect.right + 6 })
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
        className="relative text-white/40 hover:text-white/70 transition-colors p-1"
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
          className="fixed z-[9999] w-72 rounded-lg border border-white/10 bg-[#262523] shadow-2xl overflow-hidden"
          style={{ top: position.top, left: position.left }}
        >
          <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
            <span className="text-xs font-medium text-white/50">Notifications</span>
            {notifications.length > 0 && (
              <button
                className="text-[11px] text-white/30 hover:text-white/60 transition-colors"
                onClick={() => clearAll()}
              >
                Remove all
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="px-3 py-4 text-xs text-white/30 text-center">No notifications</div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {notifications.map((n) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-2 px-3 py-2 border-b border-white/5 last:border-b-0 ${n.action ? 'cursor-pointer hover:bg-white/5' : ''}`}
                  onClick={() => {
                    if (n.action) executeAction(n.action)
                    dismissNotification(n.id)
                    setOpen(false)
                  }}
                >
                  <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${TYPE_DOTS[n.type]}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white/80 leading-tight">{n.title}</div>
                    <div className="text-[11px] text-white/40 mt-0.5">{n.body}</div>
                  </div>
                  <button
                    className="flex-shrink-0 mt-0.5 w-4 h-4 flex items-center justify-center rounded hover:bg-white/10 text-white/20 hover:text-white/50"
                    onClick={(e) => { e.stopPropagation(); dismissNotification(n.id) }}
                  >
                    <X size={10} />
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
