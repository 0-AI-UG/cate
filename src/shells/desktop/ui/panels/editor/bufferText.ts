// The view's side of a file buffer (`acquireBufferText`), as React hooks.

import { useEffect, useState } from 'react'
import type * as Y from 'yjs'
import { acquireBufferText, type SharedBufferText } from '@workspace/files/client'

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
