// The shared device documents as a `DeviceStore` for the renderer: get, set
// and change events by name. Main is the only writer; a window's own sets are
// not echoed back to it.

import type { DeviceStore } from '@kernel/state/contract'
import { DESKTOP_CHANNELS as C, sharedDeviceDocument } from '../contract'
import type { DeviceFiles } from './deviceFiles'
import { handle } from './ipc'
import type { WindowRegistry } from './windowRegistry'

function documentName(name: unknown) {
  const doc = sharedDeviceDocument(name)
  if (!doc) throw new Error(`not a device document: ${String(name)}`)
  return doc
}

/** A DeviceStore over main's device files (for main-side users such as the
 *  pinned runtime keys). */
export function deviceStoreOf(files: DeviceFiles): DeviceStore {
  return {
    get: async (name) => files.get(documentName(name)),
    set: async (name, value) => { files.set(documentName(name), value, { kind: 'main' }) },
    subscribe(name, onChange) {
      const doc = documentName(name)
      return files.subscribe((changed, value) => { if (changed === doc) onChange(value) })
    },
  }
}

export function registerDeviceIpc(files: DeviceFiles, registry: Pick<WindowRegistry, 'broadcast'>): () => void {
  handle(C.deviceGet, (_event, name: unknown) => files.get(documentName(name)))
  handle(C.deviceSet, (event, name: unknown, value: unknown) => {
    files.set(documentName(name), value, { kind: 'renderer', id: event.sender.id })
  })
  return files.subscribe((name, value, origin) => {
    registry.broadcast(C.deviceChanged, [name, value], origin.kind === 'renderer' ? { exceptContents: origin.id } : {})
  })
}
