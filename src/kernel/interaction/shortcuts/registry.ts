// The shortcut registry: each declared action's binding (its default key
// under the `customShortcuts` client setting), matching and editing.

import {
  displayString,
  parseStoredShortcut,
  sameShortcut,
  shortcutMatches,
  storedShortcut,
  type ActionId,
  type ShortcutKeyEvent,
  type StoredShortcut,
} from '../contract'
import { declaredActions, subscribeDeclaredActions } from '../actions/catalog'

export type ShortcutOverrides = Record<ActionId, StoredShortcut>
/** The binding of every declared action; an empty key is unbound. */
export type ResolvedShortcuts = Readonly<Record<ActionId, StoredShortcut>>

const UNBOUND = storedShortcut('')

/** The slice of the client settings store the registry uses
 *  (`ClientSettingsStore` from kernel/settings satisfies it). */
export interface ShortcutSettings {
  get(key: 'customShortcuts'): ShortcutOverrides
  set(key: 'customShortcuts', value: ShortcutOverrides): unknown
  subscribe(cb: (values: unknown, patch: { customShortcuts?: ShortcutOverrides }) => void): () => void
}

export interface ShortcutRegistry {
  resolved(): ResolvedShortcuts
  /** The first declared action bound to this key press. */
  match(event: ShortcutKeyEvent): ActionId | null
  set(action: ActionId, shortcut: StoredShortcut): void
  /** Disables the binding (an empty key never matches). */
  clear(action: ActionId): void
  reset(action: ActionId): void
  resetAll(): void
  subscribe(cb: () => void): () => void
}

const defaultOf = (action: ActionId): StoredShortcut =>
  declaredActions().find((a) => a.id === action)?.spec.key ?? UNBOUND

export function createShortcutRegistry(settings: ShortcutSettings): ShortcutRegistry {
  let cached: { raw: unknown; declared: unknown; resolved: ResolvedShortcuts } | undefined
  const resolved = (): ResolvedShortcuts => {
    const raw = settings.get('customShortcuts')
    const declared = declaredActions()
    if (cached && cached.raw === raw && cached.declared === declared) return cached.resolved
    const table: Record<ActionId, StoredShortcut> = {}
    for (const { id, spec } of declared) {
      table[id] = (raw && typeof raw === 'object' ? parseStoredShortcut((raw as Record<string, unknown>)[id]) : null) ?? spec.key ?? UNBOUND
    }
    cached = { raw, declared, resolved: table }
    return table
  }
  // Only diffs from the defaults are stored; overrides of actions not
  // declared now are kept for when their module declares them again.
  const persist = (action: ActionId, shortcut: StoredShortcut | null): void => {
    const next = { ...settings.get('customShortcuts') }
    if (!shortcut || sameShortcut(shortcut, defaultOf(action))) delete next[action]
    else next[action] = shortcut
    settings.set('customShortcuts', next)
  }
  return {
    resolved,
    match(event) {
      const table = resolved()
      return declaredActions().find(({ id }) => table[id] && shortcutMatches(event, table[id]))?.id ?? null
    },
    set: (action, shortcut) => persist(action, shortcut),
    clear: (action) => persist(action, UNBOUND),
    reset: (action) => persist(action, null),
    resetAll: () => { settings.set('customShortcuts', {}) },
    subscribe(cb) {
      const offSettings = settings.subscribe((_values, patch) => {
        if ('customShortcuts' in patch) cb()
      })
      const offDeclared = subscribeDeclaredActions(cb)
      return () => { offSettings(); offDeclared() }
    },
  }
}

/** A registry over in-memory overrides, used until a shell installs one. */
export function createMemoryShortcutRegistry(initial: ShortcutOverrides = {}): ShortcutRegistry {
  let overrides = initial
  const listeners = new Set<(values: unknown, patch: { customShortcuts?: ShortcutOverrides }) => void>()
  return createShortcutRegistry({
    get: () => overrides,
    set: (_key, value) => {
      overrides = value
      for (const cb of listeners) cb(undefined, { customShortcuts: value })
    },
    subscribe: cb => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
  })
}

let installed: ShortcutRegistry = createMemoryShortcutRegistry()
const installListeners = new Set<() => void>()

export function installShortcutRegistry(registry: ShortcutRegistry): void {
  installed = registry
  for (const cb of installListeners) cb()
}

export function shortcutRegistry(): ShortcutRegistry {
  return installed
}

export function subscribeShortcuts(cb: () => void): () => void {
  let unsubscribe = installed.subscribe(cb)
  const onInstall = (): void => {
    unsubscribe()
    unsubscribe = installed.subscribe(cb)
    cb()
  }
  installListeners.add(onInstall)
  return () => {
    installListeners.delete(onInstall)
    unsubscribe()
  }
}

/** The display string of an action's binding, or null when unbound. */
export function shortcutDisplay(shortcuts: ResolvedShortcuts, action: ActionId | undefined): string | null {
  const binding = action ? shortcuts[action] : undefined
  return binding?.key ? displayString(binding) : null
}

