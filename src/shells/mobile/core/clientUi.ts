// The iOS core's ClientUi: links leave through the app's system browser.
// The app asks questions natively through the bridge; where a tapped link opens
// waits in the state for the app to ask (`MobileLinks`). Desktop-only dialogs
// such as save paths remain with those views.

import type { ClientUi } from '@kernel/interaction/contract'
import type { MobileBridge } from '../contract'
import type { MobileLinks } from './links'

export function createMobileClientUi(bridge: MobileBridge, links: MobileLinks): ClientUi {
  const ui = {
    openExternal: (url: string) => { void bridge('app.openUrl', { url }).catch(() => {}) },
    openSettings: () => {},
    confirm: (message: string) => bridge('app.confirm', { message }),
    showError: (message: string) => { console.warn(message) },
    showContextMenu: async () => null,
    confirmUnsavedChanges: async () => 'cancel' as const,
    promptLinkOpen: (url: string) => links.ask(url),
  }
  return ui as unknown as ClientUi
}
