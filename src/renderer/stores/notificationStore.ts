// =============================================================================
// Notification Store — Zustand state for in-app toasts + OS notification dispatch
// =============================================================================

import { create } from 'zustand'
import { useSettingsStore } from './settingsStore'
import { useAppStore, getCanvasOperations } from './appStore'
import { useDockStore } from './dockStore'
import { terminalRegistry } from '../lib/terminalRegistry'
import { findTabStack } from './dockTreeUtils'
import type { NotificationAction } from '../../shared/types'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Notification {
  id: string
  title: string
  body: string
  type: 'info' | 'success' | 'warning' | 'error'
  timestamp: number
  action?: NotificationAction
}

interface NotificationStoreState {
  /** Persistent list shown in bell popup */
  notifications: Notification[]
  /** Transient toasts shown bottom-right, auto-dismissed */
  toasts: Notification[]
}

interface NotificationStoreActions {
  notify: (payload: {
    title: string
    body: string
    type?: Notification['type']
    action?: NotificationAction
  }) => void
  dismissToast: (id: string) => void
  dismissNotification: (id: string) => void
  clearAll: () => void
  executeAction: (action: NotificationAction) => void
}

export type NotificationStore = NotificationStoreState & NotificationStoreActions

// Keep Toast as alias for backward compat with ToastContainer
export type Toast = Notification

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_TOASTS = 3
const MAX_NOTIFICATIONS = 50
const AUTO_DISMISS_MS = 5000

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

let counter = 0

export const useNotificationStore = create<NotificationStore>((set, get) => ({
  notifications: [],
  toasts: [],

  notify({ title, body, type = 'info', action }) {
    const settings = useSettingsStore.getState()
    if (!settings.notificationsEnabled) return
    if (settings.notificationMode === 'off') return

    const isFocused = document.hasFocus()
    const skipWhenFocused = settings.notifyOnlyWhenUnfocused && isFocused
    const mode = settings.notificationMode

    // OS notification (suppressed when focused if notifyOnlyWhenUnfocused is on)
    if ((mode === 'os' || mode === 'both') && !skipWhenFocused) {
      window.electronAPI?.notifyOS({ title, body, action })
    }

    const id = `notif-${++counter}`
    const entry: Notification = { id, title, body, type, timestamp: Date.now(), action }

    // Always add to persistent history
    set((state) => {
      const notifications = [entry, ...state.notifications].slice(0, MAX_NOTIFICATIONS)
      return { notifications }
    })

    // In-app toast (always shown regardless of focus)
    if (mode === 'inApp' || mode === 'both') {
      set((state) => {
        const toasts = [...state.toasts, entry]
        while (toasts.length > MAX_TOASTS) toasts.shift()
        return { toasts }
      })

      // Auto-dismiss toast only (notification stays in history)
      // Errors get a longer dismiss time so they're not missed
      const dismissMs = type === 'error' ? 10000 : AUTO_DISMISS_MS
      setTimeout(() => {
        get().dismissToast(id)
      }, dismissMs)
    }
  },

  dismissToast(id) {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },

  dismissNotification(id) {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }))
  },

  clearAll() {
    set({ notifications: [], toasts: [] })
  },

  executeAction(action) {
    switch (action.type) {
      case 'focusTerminal': {
        const { workspaceId, terminalId } = action
        useAppStore.getState().selectWorkspace(workspaceId)
        // terminalId is the ptyId — resolve to panelId for canvas lookup
        const panelId = terminalRegistry.panelIdForPty(terminalId) ?? terminalId
        // Wait for React to process the workspace switch before focusing the panel
        requestAnimationFrame(() => {
          const dock = useDockStore.getState()
          const location = dock.getPanelLocation(panelId)

          if (location?.type === 'dock') {
            // Panel is in a dock zone — ensure zone is visible and activate the tab
            const zone = dock.zones[location.zone]
            if (!zone.visible) {
              dock.toggleZone(location.zone)
            }
            if (zone.layout) {
              const stack = findTabStack(zone.layout, location.stackId)
              if (stack) {
                const tabIndex = stack.panelIds.indexOf(panelId)
                if (tabIndex >= 0) {
                  dock.setActiveTab(location.stackId, tabIndex)
                }
              }
            }
          } else {
            // Panel is on the canvas (or location unknown) — focus via canvas
            getCanvasOperations()?.focusPanelNode(panelId)
          }
        })
        break
      }
    }
  },
}))

// -----------------------------------------------------------------------------
// Subscribe to OS notification click actions from main process
// -----------------------------------------------------------------------------

if (typeof window !== 'undefined') {
  const api = (window as any).electronAPI
  if (api?.onNotifyAction) {
    api.onNotifyAction((action: NotificationAction) => {
      useNotificationStore.getState().executeAction(action)
    })
  }
}
