import fs from 'node:fs/promises'
import os from 'os'
import path from 'node:path'
import log from './logger'
import { bundledSkillSource } from '../skills/main/bundledSkillSource'
import { localSkillFiles } from '../skills/main/localSkillFiles'
import { withBundleTransaction, readDirectory, replaceBundle, reconcileManagedBundle, isMissingError } from '../skills/main/skillBundle'
import { withSkillWorkspaces, writeSkillJson } from '../skills/main/skillWorkspace'

/** Global placement is intentional; discovery/publication and managed ownership
 * are shared with workspace skills. Failed publication remains retryable. */
export async function installBundledSkill(name: string): Promise<void> {
  const source = bundledSkillSource(name)
  if (!source) return
  const root = path.join(os.homedir(), '.claude', 'skills')
  const destination = path.join(root, name)
  const manifestPath = path.join(root, '.cate', `${name}.json`)
  try {
    await withSkillWorkspaces([root], () => withBundleTransaction(async () => {
      let current: Awaited<ReturnType<typeof readDirectory>> = []
      let exists = false
      try { current = await readDirectory(localSkillFiles, 'local', destination); exists = true }
      catch (error) { if (!isMissingError(error)) throw error }
      let owned: Record<string, string> = {}
      try { owned = JSON.parse(await fs.readFile(manifestPath, 'utf8')) } catch { /* Legacy copies remain user-owned. */ }
      const incoming = await readDirectory(localSkillFiles, 'local', source)
      const next = reconcileManagedBundle(current, incoming, owned)
      await fs.mkdir(root, { recursive: true })
      await replaceBundle(localSkillFiles, 'local', root, destination, next.files, 'folder', exists, root)
      await fs.mkdir(path.dirname(manifestPath), { recursive: true })
      await writeSkillJson(localSkillFiles, manifestPath, next.managedFiles)
    }))
  } catch (error) { log.warn('[installBundledSkill] install of %s failed: %O', name, error) }
}
