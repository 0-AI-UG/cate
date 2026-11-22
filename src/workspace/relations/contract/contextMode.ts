// The user's policy is document state; automatic delivery state lives in
// the agents runtime and never changes this preference.
export type RelationContextMode = 'auto' | 'once' | 'always' | 'off'

/** The record field holding a panel's mode. */
export const RELATION_CONTEXT_MODE_FIELD = 'relationContextMode'

/** A panel's mode from its record fields; automatic unless explicitly set. */
export function relationContextMode(fields: Readonly<Record<string, unknown>>): RelationContextMode {
  const mode = fields[RELATION_CONTEXT_MODE_FIELD]
  return mode === 'once' || mode === 'always' || mode === 'off' ? mode : 'auto'
}
