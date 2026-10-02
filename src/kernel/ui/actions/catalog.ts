// The declared actions of this client, in declaration order: what menus, the
// palette, the shortcuts settings and tooltips list. Modules declare their
// specs here (client/host's `registerActions` does it with the bindings);
// what an action does is client/host's.

import { useSyncExternalStore } from 'react'
import type { ActionId, ActionSpec, ActionSpecs } from '../contract'

export interface DeclaredAction {
  id: ActionId
  spec: ActionSpec
}

const specs = new Map<ActionId, ActionSpec>()
const listeners = new Set<() => void>()
let snapshot: readonly DeclaredAction[] = []

function changed(): void {
  snapshot = [...specs].map(([id, spec]) => ({ id, spec }))
  for (const listener of [...listeners]) listener()
}

/** Declares actions; returns the undo. A later declaration of an id
 *  replaces the earlier one until it is undone. */
export function declareActions(next: ActionSpecs): () => void {
  for (const [id, spec] of Object.entries(next)) specs.set(id, spec)
  changed()
  return () => {
    let removed = false
    for (const [id, spec] of Object.entries(next)) {
      if (specs.get(id) !== spec) continue
      specs.delete(id)
      removed = true
    }
    if (removed) changed()
  }
}

export function actionSpec(id: ActionId): ActionSpec | undefined {
  return specs.get(id)
}

export function declaredActions(): readonly DeclaredAction[] {
  return snapshot
}

export function subscribeDeclaredActions(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The declared actions; re-renders when a module declares or withdraws. */
export function useDeclaredActions(): readonly DeclaredAction[] {
  return useSyncExternalStore(subscribeDeclaredActions, declaredActions)
}
