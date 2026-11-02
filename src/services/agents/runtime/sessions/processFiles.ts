import { execFile } from 'node:child_process'
import { readdir, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Only files held by this process; no transcript directory search. */
export async function processFiles(pid: number): Promise<string[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return []
  try {
    if (process.platform === 'linux') {
      const root = `/proc/${pid}/fd`
      const names = await readdir(root)
      return await Promise.all(names.map((name) => readlink(`${root}/${name}`).catch(() => '')))
    }
    if (process.platform === 'darwin') {
      const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-Fn'], { timeout: 2_000, maxBuffer: 1024 * 1024 })
      return stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1))
    }
  } catch { /* A process may exit during the probe, or deny access. */ }
  return []
}
