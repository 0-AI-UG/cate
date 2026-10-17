// File buffers in the app's editor views (`buffer.*`): the shared Yjs buffer
// of a file (`acquireBufferText`, the one the desktop editor binds), as plain
// text. The app edits it with UTF-16 ranges, the units of both Y.Text and
// NSString. The buffer has a version, one more on every change: the text
// comes whole once, at its version; changes made elsewhere come as deltas
// from one version to the next, and every edit answers with the version
// after it, so the app sees when changes made elsewhere came between its own
// and asks for the text whole (`text`). `warm` starts a file's sync before
// its view asks, holding the buffer for `WARM_MS`.

import { errorMessage } from '@kernel/interaction'
import { acquireBufferText, type SharedBufferText } from '@workspace/files/client'
import { getDocumentType } from '@workspace/files/contract'
import type { MobileBridge, MobileTextDelta, MobileViewEvent } from '../contract'

/** How long a warmed buffer is held for the view that opens it. */
export const WARM_MS = 10_000

interface OpenBuffer {
  /** Answers with the version after the edit. */
  edit(from: number, length: number, text: string): number
  text(): { text: string; version: number }
  close(): void
}

type YDelta = Array<{ insert?: unknown; retain?: number; delete?: number }>

function deltaOf(delta: YDelta): MobileTextDelta[] {
  const out: MobileTextDelta[] = []
  for (const step of delta) {
    if (typeof step.insert === 'string') out.push({ insert: step.insert })
    else if (step.retain) out.push({ retain: step.retain })
    else if (step.delete) out.push({ delete: step.delete })
  }
  return out
}

export interface MobileBuffers {
  open(params: { viewId: string; workspaceId: string; path: string }): void
  get(viewId: string): OpenBuffer | undefined
  warm(params: { workspaceId: string; path: string }): void
}

export function createMobileBuffers(bridge: MobileBridge): MobileBuffers {
  const open = new Map<string, OpenBuffer>()
  const warmed = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    open({ viewId, workspaceId, path }) {
      open.get(viewId)?.close()
      let closed = false
      const emit = (event: MobileViewEvent) => {
        if (!closed) void bridge('view.event', { viewId, json: JSON.stringify(event) }).catch(() => {})
      }
      let buffer: SharedBufferText | null = null
      let synced = false
      let version = 0
      // This view's edits, told apart from every other change.
      const origin = {}
      const observer = (event: { delta: YDelta }, transaction: { origin: unknown }) => {
        version++
        if (transaction.origin !== origin) emit({ kind: 'change', from: version - 1, to: version, delta: deltaOf(event.delta) })
      }
      try {
        buffer = acquireBufferText(workspaceId, path)
        buffer.ready.then(() => {
          if (closed) return
          synced = true
          buffer!.text.observe(observer)
          emit({ kind: 'text', text: buffer!.text.toString(), version })
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
          }, origin)
          return version
        },
        text() {
          if (!buffer || !synced) throw new Error('The file is not open yet.')
          return { text: buffer.text.toString(), version }
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
    warm({ workspaceId, path }) {
      if (getDocumentType(path)) return
      const key = `${workspaceId}\0${path}`
      if (warmed.has(key)) return
      let buffer: SharedBufferText
      try {
        buffer = acquireBufferText(workspaceId, path)
      } catch {
        return
      }
      // A file that cannot open says so to its view, not here.
      buffer.ready.catch(() => {})
      warmed.set(key, setTimeout(() => {
        warmed.delete(key)
        buffer.release()
      }, WARM_MS))
    },
  }
}
