import { useSyncExternalStore } from 'react'
import { declaredActions, subscribeDeclaredActions, type DeclaredAction } from '@kernel/interaction'

/** The declared actions; re-renders when a module declares or withdraws. */
export function useDeclaredActions(): readonly DeclaredAction[] {
  return useSyncExternalStore(subscribeDeclaredActions, declaredActions)
}
