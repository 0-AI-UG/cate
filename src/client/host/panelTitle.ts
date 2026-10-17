// How a panel reads in lists and tabs, the same everywhere.

import type { PanelRecord } from '@workspace/document/contract'
import { panelLabel } from './definitions'

/** The record's title, else its type's label. */
export function panelRowLabel(record: Pick<PanelRecord, 'type' | 'title'>): string {
  return record.title || panelLabel(record.type)
}
