// The words of a note or a text block, a record field (`panels/note/contract`):
// typing updates a local copy at once and proposes one `updatePanel` op after
// a short pause, on blur and on unmount, so the workspace saves them with the
// node's position. While the field has focus a change from another client
// does not overwrite what is being typed; typed words win (last write wins),
// and without edits the field catches up once it is left.

import { useCallback, useEffect, useRef, useState } from 'react'
import { documentStoreFor } from '@client/document'
import { NOTE_TEXT_FIELD, noteText } from '@panels/note/contract'
import type { PanelRecord } from '@workspace/document/contract'

/** Pause after the last keystroke before the words are saved. */
export const TEXT_SAVE_DELAY_MS = 400

export interface BlockText {
  value: string
  /** The field's onChange. */
  change(text: string): void
  /** The field's onBlur: saves now. */
  leave(): void
}

export function useBlockText(workspaceId: string, record: PanelRecord, field: React.RefObject<HTMLElement>): BlockText {
  const saved = noteText(record)
  const savedRef = useRef(saved)
  savedRef.current = saved
  const [value, setValue] = useState(saved)
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const text = pending.current
    pending.current = null
    if (text === null) return
    documentStoreFor(workspaceId)?.propose({ kind: 'updatePanel', id: record.id, patch: { fields: { [NOTE_TEXT_FIELD]: text } } })
  }, [workspaceId, record.id])

  // Words saved elsewhere show here unless they are being typed.
  useEffect(() => {
    if (pending.current === null && document.activeElement !== field.current) setValue(saved)
  }, [saved, field])

  useEffect(() => flush, [flush])

  const change = useCallback((text: string) => {
    setValue(text)
    pending.current = text
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, TEXT_SAVE_DELAY_MS)
  }, [flush])

  const leave = useCallback(() => {
    const edited = pending.current !== null
    flush()
    if (!edited) setValue(savedRef.current)
  }, [flush])

  return { value, change, leave }
}
