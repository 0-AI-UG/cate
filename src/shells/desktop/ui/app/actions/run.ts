// Running an action for this window: the context is the workspace it shows.

import type { ActionId } from '@kernel/interaction/contract'
import { canRunAction, runAction, type ActionContext } from '@client/host'
import { useUIStore } from '../state/uiStore'
import { shownWindow } from '../state/windowContext'

export function windowActionContext(): ActionContext {
  return { workspaceId: useUIStore.getState().selectedWorkspaceId, windowId: shownWindow() }
}

/** Runs an action for this window's workspace; false when it cannot run. */
export function runWindowAction(action: ActionId, context: ActionContext = windowActionContext()): boolean {
  if (!canRunAction(action, context)) return false
  void runAction(action, context)
  return true
}
