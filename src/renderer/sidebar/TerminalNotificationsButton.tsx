import React from 'react'
import { DotsThree } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useNotificationStore } from '../stores/notificationStore'
import type { Notification } from '../stores/notificationStore'
import { terminalRegistry } from '../lib/terminalRegistry'

export function useTerminalNotifications(panelId: string): Notification[] {
  return useNotificationStore(useShallow((s) =>
    s.notifications.filter((n) => {
      const action = n.action
      if (!action || action.type !== 'focusTerminal') return false
      const targetPanelId = terminalRegistry.panelIdForPty(action.terminalId) ?? action.terminalId
      return targetPanelId === panelId
    }),
  ))
}

interface InlineProps {
  notifications: Notification[]
}

export const TerminalNotificationInline: React.FC<InlineProps> = ({ notifications }) => {
  if (notifications.length === 0) return null
  const latest = notifications[0]
  return (
    <>
      <span className="flex-shrink min-w-0 truncate text-[12px] text-muted opacity-70 italic">
        {latest.title}
      </span>
      <span className="flex-shrink-0 text-muted opacity-50">
        <DotsThree size={14} weight="bold" />
      </span>
    </>
  )
}
