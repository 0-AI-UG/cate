// The client features the desktop shell declares (architecture 12.2). This is
// the only place the shell looks at its platform.

import type { ClientFeature } from '@kernel/rpc/contract'

/** Every feature but `camera`; `passkeys` only on macOS, and only when the
 *  native passkey bridge actually loaded there. */
export function desktopClientFeatures(platform: string, options: { passkeysAvailable?: boolean } = {}): ClientFeature[] {
  const features: ClientFeature[] = [
    'webview',
    'pageDriver',
    'windows',
    'canvas',
    'fileDrop',
    'osNotifications',
    'screenCapture',
    'clipboard',
  ]
  if (platform === 'darwin' && options.passkeysAvailable !== false) features.splice(2, 0, 'passkeys')
  return features
}
