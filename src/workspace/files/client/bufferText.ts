// A file buffer's text on this client. Views attach to the runtime's buffer
// through the `file.buffer` stream (not the session channel): it already does
// the y-protocols sync with state vectors and resumes after a reconnect, and
// the buffer is shared by every editor of the file while the session channel
// is per panel. The session keeps its own handle, so the buffer lives while
// the panel does. Panels of one client showing the same file share one doc.

import * as Y from 'yjs'
import { runtimeFor } from '@kernel/rpc/client'
import { BUFFER_TEXT, pathKey } from '../contract'
import { attachBuffer, type AttachedBuffer } from './bufferClient'

interface Entry {
  doc: Y.Doc
  text: Y.Text
  attached: AttachedBuffer
  refs: number
}

const entries = new Map<string, Entry>()

export interface SharedBufferText {
  readonly text: Y.Text
  readonly ready: Promise<void>
  release(): void
}

export function acquireBufferText(workspaceId: string, filePath: string): SharedBufferText {
  const key = `${workspaceId}\0${pathKey(filePath)}`
  let entry = entries.get(key)
  if (!entry) {
    const doc = new Y.Doc()
    const attached = attachBuffer(runtimeFor(workspaceId).file, filePath, doc)
    entry = { doc, text: doc.getText(BUFFER_TEXT), attached, refs: 0 }
    entries.set(key, entry)
  }
  const held = entry
  held.refs++
  let released = false
  return {
    text: held.text,
    ready: held.attached.ready,
    release() {
      if (released) return
      released = true
      if (--held.refs > 0 || entries.get(key) !== held) return
      entries.delete(key)
      held.attached.close()
      held.doc.destroy()
    },
  }
}
