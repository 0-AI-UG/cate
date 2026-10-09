// When an execution panel's prompt takes its connected panels' context: the
// next message only (then off), every message, or never. A panel record
// field, read the same way everywhere.

export type RelationContextMode = 'once' | 'always' | 'off'

/** The record field holding a panel's mode. */
export const RELATION_CONTEXT_MODE_FIELD = 'relationContextMode'

/** A panel's mode from its record fields; `once` when never set. */
export function relationContextMode(fields: Readonly<Record<string, unknown>>): RelationContextMode {
  const mode = fields[RELATION_CONTEXT_MODE_FIELD]
  return mode === 'always' || mode === 'off' ? mode : 'once'
}
