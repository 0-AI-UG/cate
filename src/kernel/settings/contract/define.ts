// defineSettings: each module declares its settings slice once (keys, defaults,
// validation, scope). The kernel composes the slices into the settings types
// and one validation table per scope.

import { isPlainObject } from '../../state/contract'

export type SettingsScope = 'client' | 'workspace'

export interface SettingDef<T> {
  default: T
  /** Extra checks after the base check (same JSON kind as the default). */
  validate?: (value: T) => boolean
}

// `any` lets any concrete key satisfy the constraint; values are recovered with
// `infer` below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SettingDefs = Record<string, SettingDef<any>>

export interface SettingsSlice<S extends SettingsScope = SettingsScope, K extends SettingDefs = SettingDefs> {
  readonly scope: S
  readonly keys: K
}

export type SliceValues<K extends SettingDefs> = { [N in keyof K]: K[N] extends SettingDef<infer T> ? T : never }

/** Pins a key's value type, which a bare `{ default }` would widen or narrow. */
export function setting<T>(defaultValue: T, validate?: (value: NoInfer<T>) => boolean): SettingDef<T> {
  return validate ? { default: defaultValue, validate } : { default: defaultValue }
}

export function defineSettings<S extends SettingsScope, K extends SettingDefs>(slice: {
  scope: S
  keys: K
}): SettingsSlice<S, K> {
  return Object.freeze({ scope: slice.scope, keys: Object.freeze(slice.keys) })
}

// ---- Validators --------------------------------------------------------------

export function oneOf<const V extends readonly string[]>(...values: V): (value: string) => boolean {
  return (value) => values.includes(value)
}

export function numberIn(min: number, max: number, opts: { integer?: boolean } = {}): (value: number) => boolean {
  return (value) => value >= min && value <= max && (!opts.integer || Number.isInteger(value))
}

export function everyItem<T>(check: (item: unknown) => boolean): (value: T[]) => boolean {
  return (value) => value.every(check)
}

export function everyValue<T>(check: (value: unknown, key: string) => boolean): (value: T) => boolean {
  return (value) => Object.entries(value as Record<string, unknown>).every(([key, v]) => check(v, key))
}

type JsonKind = 'string' | 'number' | 'boolean' | 'array' | 'object'

function kindOf(value: unknown): JsonKind | null {
  if (Array.isArray(value)) return 'array'
  if (isPlainObject(value)) return 'object'
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null
  if (typeof value === 'string' || typeof value === 'boolean') return typeof value as JsonKind
  return null
}

// ---- Composition ------------------------------------------------------------

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySlice = SettingsSlice<SettingsScope, any>

/** The values of every slice of scope `S` in the union `U`, as one object type. */
export type ComposedSettings<U extends AnySlice, S extends SettingsScope> = UnionToIntersection<
  U extends SettingsSlice<S, infer K> ? SliceValues<K> : never
>

export interface SettingsTable<V extends object> {
  readonly scope: SettingsScope
  readonly keys: ReadonlyArray<keyof V & string>
  readonly defaults: Readonly<V>
  has(key: string): key is keyof V & string
  /** Known key and a value of the right kind that passes the slice's checks. */
  validate(key: string, value: unknown): boolean
  /** Raw parsed JSON to a complete value: defaults, then every valid known
   *  key. Never throws. */
  normalize(parsed: unknown): V
}

/** Compose the slices of one scope into a table. Throws on a key declared twice. */
export function composeSettings<V extends object>(scope: SettingsScope, slices: readonly AnySlice[]): SettingsTable<V> {
  const defs = new Map<string, SettingDef<unknown>>()
  for (const slice of slices) {
    if (slice.scope !== scope) continue
    for (const [key, def] of Object.entries(slice.keys as SettingDefs)) {
      if (defs.has(key)) throw new Error(`Setting "${key}" is declared twice`)
      if (kindOf(def.default) === null) throw new Error(`Setting "${key}" has a non-JSON default`)
      defs.set(key, def)
    }
  }
  const defaults = Object.freeze(Object.fromEntries([...defs].map(([key, def]) => [key, def.default]))) as V
  const has = (key: string): key is keyof V & string => defs.has(key)
  const validate = (key: string, value: unknown): boolean => {
    const def = defs.get(key)
    if (!def || kindOf(value) !== kindOf(def.default)) return false
    try {
      return def.validate ? def.validate(value) : true
    } catch {
      return false
    }
  }
  return {
    scope,
    keys: Object.freeze([...defs.keys()]) as ReadonlyArray<keyof V & string>,
    defaults,
    has,
    validate,
    normalize(parsed) {
      const next: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
      if (isPlainObject(parsed)) {
        for (const key of defs.keys()) {
          if (key in parsed && validate(key, parsed[key])) next[key] = parsed[key]
        }
      }
      return next as V
    },
  }
}
