import { promises as fs } from 'node:fs'
import path from 'node:path'
import { CATE_GITIGNORE } from '../contract'

/** Makes sure `<root>/.cate/.gitignore` exists. Write-once: a file the user
 *  customised is left alone. Every writer of `.cate/` calls this. */
export async function ensureCateGitignore(root: string): Promise<void> {
  const dir = path.join(root, '.cate')
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, '.gitignore'), CATE_GITIGNORE, { flag: 'wx' })
  } catch {
    // Already there, or the directory is not writable: nothing to do.
  }
}
