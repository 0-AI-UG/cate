// =============================================================================
// projectTrustGate — the one place the trust decision meets the layout files.
//
// Every path that turns `.cate/workspace.json` + `.cate/session.json` into a
// live layout goes through here: startup load, hydrate-on-open, and
// reload-from-disk. Trusted projects pass through untouched; untrusted ones are
// reduced to passive state by `filterUntrustedProjectFiles` and the withheld
// summary is recorded for the banner.
//
// Kept separate from `sessionTrustFilter` (pure, unit-tested) so the filter
// never has to reach into a store.
// =============================================================================

import log from '../logger'
import { filterUntrustedProjectFiles } from './sessionTrustFilter'
import { useWorkspaceTrustStore } from '../../stores/workspaceTrustStore'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../../../shared/types'

export interface GatedProjectFiles {
  workspace: ProjectWorkspaceFile
  session: ProjectSessionFile | null
}

/**
 * Apply the workspace-trust boundary to a project's layout files.
 *
 * `workspaceId` is where a withheld-notice is filed so the banner can offer to
 * restore the rest. Pass it when the workspace record already exists; the
 * startup path files its notice later, once ids are assigned.
 */
export function gateProjectFiles(
  ws: ProjectWorkspaceFile,
  sess: ProjectSessionFile | null,
  rootPath: string,
  workspaceId?: string,
): GatedProjectFiles {
  const trust = useWorkspaceTrustStore.getState()
  if (trust.isTrusted(rootPath)) return { workspace: ws, session: sess }

  const { workspace, session, withheld } = filterUntrustedProjectFiles(ws, sess, rootPath)
  if (withheld.total > 0) {
    log.info(
      '[trust] %s is not trusted — withheld %d panel(s) from its layout: %o',
      rootPath, withheld.total, withheld.byType,
    )
    if (workspaceId) trust.noteWithheld(workspaceId, rootPath, withheld)
    else trust.notePending(rootPath, withheld)
  }
  return { workspace, session }
}

/**
 * Trust a project and return its unfiltered layout files, for the banner's
 * "Restore layout" action. The caller replays them through the normal restore.
 */
export async function trustProjectAndReload(
  workspaceId: string,
  rootPath: string,
): Promise<void> {
  const trust = useWorkspaceTrustStore.getState()
  await trust.setTrusted(rootPath, true)
  trust.clearWithheld(workspaceId)
  // Replay from disk now that the gate is open. Dynamic import breaks the cycle
  // with sessionRestore, which imports this module.
  const { reloadWorkspaceFromDisk } = await import('./sessionRestore')
  await reloadWorkspaceFromDisk(workspaceId)
}
