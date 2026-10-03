import { promises as fs } from 'node:fs'
import path from 'node:path'
import { workspacesDir } from '../node/paths'
import { readRuntimeInfo } from './runtimeInfo'
import { socketAnswers } from './socketLock'

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

export interface OverlappingRuntime {
  root: string
  /** Its local socket. */
  endpoint: string
}

/**
 * The live runtime on this machine whose root contains `root` or lies inside
 * it. Workspaces never nest: both runtimes would write the same repo's agent
 * hook files and watch the same tree. Live means its socket answers: a
 * runtime.json left by a killed runtime (whose pid may be reused) does not
 * count.
 */
export async function overlappingRuntime(root: string, home?: string): Promise<OverlappingRuntime | undefined> {
  const dir = workspacesDir(home)
  const ids = await fs.readdir(dir).catch(() => [] as string[])
  for (const id of ids) {
    const info = await readRuntimeInfo(path.join(dir, id))
    if (!info || typeof info.root !== 'string' || !isAlive(info.pid)) continue
    if (!contains(info.root, root) && !contains(root, info.root)) continue
    if (!(await socketAnswers(info.endpoints.local, 1000))) continue
    return { root: info.root, endpoint: info.endpoints.local }
  }
  return undefined
}
