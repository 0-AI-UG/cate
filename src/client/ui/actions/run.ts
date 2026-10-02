// Running an action for this window: the context is the workspace it shows.

import type { ActionId } from '@kernel/ui/contract'
import { canRunAction, runAction, type ActionContext } from '@client/host'
import { useUIStore } from '../state/uiStore'

export function windowActionContext(): ActionContext {
  return { workspaceId: useUIStore.getState().selectedWorkspaceId }
}

/** Runs an action for this window's workspace; false when it cannot run. */
export function runWindowAction(action: ActionId, context: ActionContext = windowActionContext()): boolean {
  if (!canRunAction(action, context)) return false
  void runAction(action, context)
  return true
}
