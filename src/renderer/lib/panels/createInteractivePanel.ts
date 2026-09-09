import type { PanelState, PanelType } from '../../../shared/types'
import { getPanelDef, type PanelCreateArgs } from '../../panels/registry'
import { useAppStore } from '../../stores/appStore'
import { inheritedWorktreeFromPanel } from '../inheritWorktree'

/** Interactive callers supply their originating panel; factories receive one
 * explicit checkout contract regardless of toolbar, menu, shortcut or dock. */
export function createInteractivePanel(type: PanelType, args: PanelCreateArgs, origin?: PanelState): string | null {
  const app = useAppStore.getState()
  const inherited = inheritedWorktreeFromPanel(origin, app.getWorkspace(args.workspaceId)?.worktrees)
  const context = { ...inherited, ...args }
  const id = getPanelDef(type).create(context)
  if (id && type === 'surface' && context.worktreeId) app.setPanelWorktreeId(args.workspaceId, id, context.worktreeId)
  return id
}
