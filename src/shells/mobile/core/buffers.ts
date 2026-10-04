// File buffers in the app's editor views (`buffer.*`): the shared Yjs buffer
// of a file (`acquireBufferText`, the one the desktop editor binds), as plain
// text. The app edits it with UTF-16 ranges, the units of both Y.Text and
// NSString; every edit answers with the whole text after it, so the app can
// take edits made elsewhere while its own were in flight. Changes made
// elsewhere are pushed whole as `text` events.

import { errorMessage } from '@kernel/interaction'
import { acquireBufferText, type SharedBufferText } from '@workspace/files/client'
import type { MobileBridge, MobileViewEvent } from '../contract'

const LOCAL = Symbol('mobile-buffer-edit')

interface OpenBuffer {
  edit(from: number, length: number, text: string): string
  close(): void
}

export interface MobileBuffers {
  open(params: { viewId: string; workspaceId: string; path: string }): void
  get(viewId: string): OpenBuffer | undefined
}

export function createMobileBuffers(bridge: MobileBridge): MobileBuffers {
  const open = new Map<string, OpenBuffer>()

  return {
    open({ viewId, workspaceId, path }) {
      open.get(viewId)?.close()
      let closed = false
      const emit = (event: MobileViewEvent) => {
        if (!closed) void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      let buffer: SharedBufferText | null = null
      let synced = false
      const observer = (_event: unknown, transaction: { origin: unknown }) => {
        if (transaction.origin !== LOCAL) emit({ kind: 'text', text: buffer!.text.toString() })
      }
      try {
        buffer = acquireBufferText(workspaceId, path)
        buffer.ready.then(() => {
          if (closed) return
          synced = true
          buffer!.text.observe(observer)
          emit({ kind: 'text', text: buffer!.text.toString() })
        }, (error: unknown) => emit({ kind: 'error', message: errorMessage(error, 'Could not open this file.') }))
      } catch (error) {
        queueMicrotask(() => emit({ kind: 'error', message: errorMessage(error, 'Could not open this file.') }))
      }
      const entry: OpenBuffer = {
        edit(from, length, text) {
          if (!buffer || !synced) throw new Error('The file is not open yet.')
          const ytext = buffer.text
          const start = Math.max(0, Math.min(from, ytext.length))
          const count = Math.max(0, Math.min(length, ytext.length - start))
          ytext.doc!.transact(() => {
            if (count > 0) ytext.delete(start, count)
            if (text) ytext.insert(start, text)
          }, LOCAL)
          return ytext.toString()
        },
        close() {
          if (closed) return
          closed = true
          if (synced) buffer?.text.unobserve(observer)
          buffer?.release()
          if (open.get(viewId) === entry) open.delete(viewId)
        },
      }
      open.set(viewId, entry)
    },
    get: (viewId) => open.get(viewId),
  }
}
