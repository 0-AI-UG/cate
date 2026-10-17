import { describe, expect, it } from 'vitest'
import { CLIENT_FEATURES } from '@kernel/rpc/contract'
import { desktopClientFeatures } from './features'

describe('desktop client features', () => {
  it('declares every feature but camera on macOS', () => {
    expect(new Set(desktopClientFeatures('darwin'))).toEqual(new Set(CLIENT_FEATURES.filter((f) => f !== 'camera')))
  })

  it('declares passkeys only on macOS, and only when the bridge loaded', () => {
    for (const platform of ['win32', 'linux']) {
      const features = desktopClientFeatures(platform)
      expect(features).not.toContain('passkeys')
      expect(features).not.toContain('camera')
      expect(features).toHaveLength(CLIENT_FEATURES.length - 2)
    }
    expect(desktopClientFeatures('darwin', { passkeysAvailable: false })).not.toContain('passkeys')
  })
})
