// The device: its documents (`DeviceStore`) in the app's files, and its key
// in the Keychain, created on first launch.

import type { DeviceStore } from '@kernel/state/contract'
import { decodeKeyPair, encodeKeyPair, generateKeyPair, type KeyPair } from '@runtime/security/contract'
import type { MobileBridge } from '../contract'

const DEVICE_KEY = 'device-key'

/** Only this page writes the files, so there are no outside changes. */
export function createDeviceStore(bridge: MobileBridge): DeviceStore {
  return {
    async get(name) {
      const json = await bridge('device.get', { name })
      return json === null ? undefined : JSON.parse(json)
    },
    async set(name, value) {
      await bridge('device.set', { name, json: JSON.stringify(value) })
    },
    subscribe: () => () => {},
  }
}

export async function loadDeviceKeys(bridge: MobileBridge): Promise<KeyPair> {
  const stored = await bridge('keychain.get', { name: DEVICE_KEY })
  if (stored !== null) {
    let keys: KeyPair | null = null
    try { keys = decodeKeyPair(JSON.parse(stored)) } catch { keys = null }
    if (keys) return keys
    console.error('The stored device key is not a valid key pair; creating a new one (paired workspaces must pair again)')
  }
  const keys = generateKeyPair()
  await bridge('keychain.set', { name: DEVICE_KEY, value: JSON.stringify(encodeKeyPair(keys)) })
  return keys
}
