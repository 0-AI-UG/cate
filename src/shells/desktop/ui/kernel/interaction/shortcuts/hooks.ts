import { useCallback, useSyncExternalStore } from 'react'
import type { ActionId } from '@kernel/interaction/contract'
import { shortcutDisplay, shortcutRegistry, subscribeShortcuts, type ResolvedShortcuts } from '@kernel/interaction'

/** Resolved bindings of the installed registry; re-renders on edits. */
export function useResolvedShortcuts(): ResolvedShortcuts {
  return useSyncExternalStore(subscribeShortcuts, () => shortcutRegistry().resolved())
}

/** Labels follow edits in Settings; cleared bindings don't advertise a key. */
export function useShortcutLabel(): (action: ActionId, label: string) => string {
  const shortcuts = useResolvedShortcuts()
  return useCallback(
    (action, label) => {
      const key = shortcutDisplay(shortcuts, action)
      return key ? `${label} (${key})` : label
    },
    [shortcuts],
  )
}
