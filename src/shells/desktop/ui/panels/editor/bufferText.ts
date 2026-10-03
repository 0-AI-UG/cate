// The view's side of a file buffer. Views attach to the runtime's buffer
// through the `file.buffer` stream (not the session channel): it already does
// the y-protocols sync with state vectors and resumes after a reconnect, and
// the buffer is shared by every editor of the file while the session channel
// is per panel. The session keeps its own handle, so the buffer lives while
// the panel does. Panels of one client showing the same file share one doc.

import { useEffect, useState } from 'react'
import * as Y from 'yjs'
import { runtimeFor } from '@kernel/rpc/client'
import { attachBuffer, type AttachedBuffer } from '@workspace/files/client'
import { BUFFER_TEXT, pathKey } from '@workspace/files/contract'

interface Entry {
  doc: Y.Doc
  text: Y.Text
  attached: AttachedBuffer
  refs: number
}

const entries = new Map<string, Entry>()

interface SharedBufferText {
  readonly text: Y.Text
  readonly ready: Promise<void>
  release(): void
}

function acquireBufferText(workspaceId: string, filePath: string): SharedBufferText {
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

/** The text of `filePath`'s buffer once it synced; null while attaching or
 *  when no path is given. */
export function useBufferText(workspaceId: string, filePath: string | null): { text: Y.Text | null; error: string | null } {
  const [state, setState] = useState<{ path: string | null; text: Y.Text | null; error: string | null }>({ path: null, text: null, error: null })
  useEffect(() => {
    if (!filePath) return
    let current = true
    let buffer: SharedBufferText
    try {
      buffer = acquireBufferText(workspaceId, filePath)
    } catch (err) {
      setState({ path: filePath, text: null, error: err instanceof Error ? err.message : 'Could not open this file.' })
      return
    }
    buffer.ready.then(
      () => { if (current) setState({ path: filePath, text: buffer.text, error: null }) },
      (err) => { if (current) setState({ path: filePath, text: null, error: err instanceof Error ? err.message : 'Could not open this file.' }) },
    )
    return () => {
      current = false
      buffer.release()
      setState({ path: null, text: null, error: null })
    }
  }, [workspaceId, filePath])
  return state.path === filePath ? { text: state.text, error: state.error } : { text: null, error: null }
}

/** Follows a Y.Text's content (markdown preview, merge view). */
export function useTextContent(text: Y.Text | null): string {
  const [content, setContent] = useState(() => text?.toString() ?? '')
  useEffect(() => {
    if (!text) {
      setContent('')
      return
    }
    setContent(text.toString())
    const update = () => setContent(text.toString())
    text.observe(update)
    return () => text.unobserve(update)
  }, [text])
  return content
}
