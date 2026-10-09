// The iOS core's ClientUi: links leave through the app's system browser.
// The app asks its own questions natively, never through the core, so the
// kernel's questions have their safe answers here. The desktop views' own
// questions (closing a terminal, a link's target, a save path) are asked
// only by those views and are not part of this one.

import type { ClientUi } from '@kernel/interaction/contract'
import type { MobileBridge } from '../contract'

export function createMobileClientUi(bridge: MobileBridge): ClientUi {
  const ui = {
    openExternal: (url: string) => { void bridge('app.openUrl', { url }).catch(() => {}) },
    openSettings: () => {},
    confirm: async () => false,
    showError: (message: string) => { console.warn(message) },
    confirmUnsavedChanges: async () => 'cancel' as const,
  }
  return ui as unknown as ClientUi
}
