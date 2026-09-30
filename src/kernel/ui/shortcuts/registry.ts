// The shortcut registry: resolved bindings (defaults plus the `customShortcuts`
// client setting), matching and editing. What each action does is bound by
// client/ui.

import { useCallback, useSyncExternalStore } from 'react'
import {
  DEFAULT_SHORTCUTS,
  displayString,
  matchShortcut,
  resolveShortcuts,
  shortcutOverrides,
  storedShortcut,
  type ShortcutAction,
  type ShortcutKeyEvent,
  type StoredShortcut,
} from '../contract'

export type ShortcutOverrides = Partial<Record<ShortcutAction, StoredShortcut>>
export type ResolvedShortcuts = Record<ShortcutAction, StoredShortcut>

/** The slice of the client settings store the registry uses
 *  (`ClientSettingsStore` from kernel/settings satisfies it). */
export interface ShortcutSettings {
  get(key: 'customShortcuts'): ShortcutOverrides
  set(key: 'customShortcuts', value: ShortcutOverrides): unknown
  subscribe(cb: (values: unknown, patch: { customShortcuts?: ShortcutOverrides }) => void): () => void
}

export interface ShortcutRegistry {
  resolved(): ResolvedShortcuts
  match(event: ShortcutKeyEvent): ShortcutAction | null
  set(action: ShortcutAction, shortcut: StoredShortcut): void
  /** Disables the binding (an empty key never matches). */
  clear(action: ShortcutAction): void
  reset(action: ShortcutAction): void
  resetAll(): void
  subscribe(cb: () => void): () => void
}

export function createShortcutRegistry(settings: ShortcutSettings): ShortcutRegistry {
  let raw: unknown
  let cached: ResolvedShortcuts | undefined
  const resolved = (): ResolvedShortcuts => {
    const next = settings.get('customShortcuts')
    if (!cached || next !== raw) {
      raw = next
      cached = resolveShortcuts(next)
    }
    return cached
  }
  // Only diffs from the defaults are stored.
  const persist = (shortcuts: ResolvedShortcuts): void => {
    settings.set('customShortcuts', shortcutOverrides(shortcuts))
  }
  return {
    resolved,
    match: event => matchShortcut(event, resolved()),
    set: (action, shortcut) => persist({ ...resolved(), [action]: shortcut }),
    clear: action => persist({ ...resolved(), [action]: storedShortcut('') }),
    reset: action => persist({ ...resolved(), [action]: DEFAULT_SHORTCUTS[action] }),
    resetAll: () => { settings.set('customShortcuts', {}) },
    subscribe: cb => settings.subscribe((_values, patch) => {
      if ('customShortcuts' in patch) cb()
    }),
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

function subscribeInstalled(cb: () => void): () => void {
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

/** Resolved bindings of the installed registry; re-renders on edits. */
export function useResolvedShortcuts(): ResolvedShortcuts {
  return useSyncExternalStore(subscribeInstalled, () => installed.resolved())
}

/** Labels follow edits in Settings; cleared bindings don't advertise a key. */
export function useShortcutLabel(): (action: ShortcutAction, label: string) => string {
  const shortcuts = useResolvedShortcuts()
  return useCallback(
    (action, label) => shortcuts[action].key ? `${label} (${displayString(shortcuts[action])})` : label,
    [shortcuts],
  )
}
