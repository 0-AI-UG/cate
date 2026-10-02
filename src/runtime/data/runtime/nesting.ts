import { promises as fs } from 'node:fs'
import path from 'node:path'
import { workspacesDir } from '../node/paths'
import { readRuntimeInfo } from './runtimeInfo'

/** Whether `inner` lies strictly inside `outer`. */
function contains(outer: string, inner: string): boolean {
  const rel = path.relative(outer, inner)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The root of a live runtime on this machine that contains `root` or lies
 * inside it. Workspaces never nest: both runtimes would write the same repo's
 * agent hook files and watch the same tree.
 */
export async function nestedRuntimeRoot(root: string, home?: string): Promise<string | undefined> {
  const dir = workspacesDir(home)
  const ids = await fs.readdir(dir).catch(() => [] as string[])
  for (const id of ids) {
    const info = await readRuntimeInfo(path.join(dir, id))
    if (!info || typeof info.root !== 'string' || !isAlive(info.pid)) continue
    if (contains(info.root, root) || contains(root, info.root)) return info.root
  }
  return undefined
}
