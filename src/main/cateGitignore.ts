// =============================================================================
// One .gitignore for the whole .cate/ dir.
//
// Only workspace.json is meant to be shared/committed; everything else under
// .cate/ is machine-local — session.json, the *.tmp/*.bak atomic-write scratch
// files, the pi-agent dir (sessions + the auth.json copy), and worktrees. A
// single ignore-all-but-workspace rule covers all of it, so the subsystems that
// create .cate/ (project state, agent dir, worktrees) all funnel through here
// instead of dropping their own per-dir .gitignore.
// =============================================================================

import fsp from 'fs/promises'
import path from 'path'

const CONTENT = `# Cate project-local state. Only workspace.json is shared; everything else
# (session state, backups, the pi-agent dir, and worktrees) stays local.
*
!.gitignore
!workspace.json
`

/** Ensure <cateDir>/.gitignore exists. Best-effort and write-once: an existing
 *  file (e.g. one the user customised) is left untouched. */
export async function ensureCateGitignore(cateDir: string): Promise<void> {
  try {
    await fsp.mkdir(cateDir, { recursive: true })
    await fsp.writeFile(path.join(cateDir, '.gitignore'), CONTENT, { flag: 'wx' })
  } catch {
    /* already exists, or dir not writable — nothing to do */
  }
}
