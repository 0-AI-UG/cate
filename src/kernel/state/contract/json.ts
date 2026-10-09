/** True if `v` is a non-null, non-array object (a plain JSON object). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** `v` as a plain object, or null if it is not one. */
export function asObject(v: unknown): Record<string, unknown> | null {
  return isPlainObject(v) ? v : null
}

/** Pretty-printed with a trailing newline, so state files stay hand-editable. */
export function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/** Structural equality of two JSON values, by serialization. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
