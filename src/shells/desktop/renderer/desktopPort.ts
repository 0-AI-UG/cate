// client/ui's DesktopPort over the desktop IPC: the updater, the post-update
// feedback prompt, native menus, the window-controls inset and analytics.

import type { DesktopPort, UpdateStatus } from '@client/ui'
import type { DesktopApi, DesktopAppInfo, UpdateStatus as ShellUpdateStatus, WindowState } from '../contract'

/** Horizontal space the macOS traffic lights take at the top left. */
export const TRAFFIC_LIGHTS_WIDTH = 78

const toUpdateStatus = (status: ShellUpdateStatus): UpdateStatus => ({
  ...status,
  // client/ui has no separate "available": the download starts at once.
  state: status.state === 'available' ? 'downloading' : status.state,
})

export function createDesktopPort(api: DesktopApi, info: DesktopAppInfo): DesktopPort {
  const isMac = info.platform === 'darwin'
  let state: WindowState = { fullscreen: false, maximized: false, focused: true }
  const insetListeners = new Set<() => void>()
  const setState = (next: WindowState) => {
    const changed = next.fullscreen !== state.fullscreen
    state = next
    if (changed) for (const listener of [...insetListeners]) listener()
  }
  void api.window.state().then(setState, () => {})
  api.window.onState(setState)

  return {
    updateStatus: async () => toUpdateStatus(await api.updates.status()),
    onUpdateStatus: (listener) => api.updates.onStatus((status) => listener(toUpdateStatus(status))),
    checkForUpdates: () => api.updates.check(),
    quitAndInstallUpdate: () => api.updates.install(),
    pendingFeedback: () => api.analytics.feedbackPending(),
    onFeedbackPrompt: (listener) => api.analytics.onFeedbackPrompt(listener),
    dismissFeedback: () => api.analytics.dismissFeedback(),
    async submitFeedback({ rating, comment }) {
      const result = await api.analytics.submitFeedback({ rating, comment: comment ?? '' })
      return { buffered: !!result.buffered }
    },
    showContextMenu: (items) => api.menu.showContextMenu(items),
    onMenuAction: (listener) => api.menu.onAction(listener),
    // Only macOS draws native controls over the content; in fullscreen they hide.
    windowControlsInset: () => (isMac && !state.fullscreen ? TRAFFIC_LIGHTS_WIDTH : 0),
    onWindowControlsInsetChange(listener) {
      insetListeners.add(listener)
      return () => { insetListeners.delete(listener) }
    },
    focusWindow: (workspaceId, windowId) => { void api.windows.focus({ workspaceId, windowId }) },
    openClientSettingsFile: () => api.os.openSettingsFile(),
    async pickFolder() {
      const picked = await api.dialogs.open({ title: 'Open Folder', directory: true })
      return picked?.[0] ?? null
    },
    pickImage: () => api.dialogs.pickCanvasBackground(),
    trackEvent: (name, props) => api.analytics.track(name, props),
  }
}
