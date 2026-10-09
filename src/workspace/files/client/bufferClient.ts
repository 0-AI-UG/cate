// Attaches a local Y.Doc to a file's open buffer on the runtime: y-protocols
// style sync over the `file.buffer` stream. The runtime sends the diff against
// our state vector and then every update; we send our own updates, and after
// each (re)connect the diff the runtime lacks.

import * as Y from 'yjs'
import type { CapabilityProxy } from '@kernel/rpc/contract'
import { base64ToBytes, bytesToBase64, type BufferState, type fileCapability } from '../contract'

export interface AttachedBuffer {
  /** Resolves once the runtime's content is in the local doc. */
  readonly ready: Promise<void>
  state(): BufferState | null
  onState(listener: (state: BufferState) => void): () => void
  save(): Promise<BufferState>
  close(): void
}

const REMOTE = Symbol('buffer-remote')

export function attachBuffer(
  file: Pick<CapabilityProxy<typeof fileCapability>, 'buffer' | 'saveBuffer'>,
  path: string,
  doc: Y.Doc,
): AttachedBuffer {
  let current: BufferState | null = null
  const listeners = new Set<(state: BufferState) => void>()
  let markReady!: () => void
  let failReady!: (err: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { markReady = resolve; failReady = reject })
  ready.catch(() => {})

  const sub = file.buffer({ path, stateVector: bytesToBase64(Y.encodeStateVector(doc)) }, { resume: true })
  sub.onBytes((update) => {
    Y.applyUpdate(doc, update, REMOTE)
    markReady()
  })
  sub.onEvent((event) => {
    if (event.kind === 'sync') {
      const missing = Y.encodeStateAsUpdate(doc, base64ToBytes(event.stateVector))
      // An empty diff is two bytes (no structs, no deletes).
      if (missing.length > 2) sub.write(missing)
      return
    }
    current = event.state
    for (const l of [...listeners]) {
      try { l(event.state) } catch { /* isolate listeners */ }
    }
  })
  sub.done.then(() => failReady(new Error('Buffer stream ended')), failReady)

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin !== REMOTE) sub.write(update)
  }
  doc.on('update', onUpdate)

  return {
    ready,
    state: () => current,
    onState(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    save: () => file.saveBuffer({ path }),
    close() {
      doc.off('update', onUpdate)
      listeners.clear()
      sub.cancel()
    },
  }
}
