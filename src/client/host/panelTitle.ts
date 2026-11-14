// How a panel reads in lists and tabs, the same everywhere.

import { panelLabel } from './definitions'

/** The record's title, else its type's label. */
export function panelRowLabel(record: { type: string; title: string }): string {
  return record.title || panelLabel(record.type)
}
