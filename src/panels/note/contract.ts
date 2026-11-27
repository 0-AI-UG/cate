// The note panel's record: its words live in one record field, so they are
// document state (shared with every client, saved in `document.json`, last
// write wins) next to the node rect that holds the note's position. The text
// panel keeps its words the same way. Pure.

import type { PanelRecord } from '@workspace/document/contract'

/** The record field holding a note's (or a text block's) words. */
export const NOTE_TEXT_FIELD = 'text'

/** A note's words; empty for a fresh note. */
export function noteText(record: PanelRecord): string {
  const text = record.fields[NOTE_TEXT_FIELD]
  return typeof text === 'string' ? text : ''
}

