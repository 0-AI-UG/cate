// Git evidence for recorded patches. The agents service owns the records and
// their lifetime; the repository owns reading Git and matching commit evidence.
import { lstat, readFile, readlink, stat } from 'node:fs/promises'
import path from 'node:path'
import { parseReviewPatch, type GitDiffHunk, type GitCommitSummary } from '../contract'

export interface TrackedPatch {
  key: string
  path: string
  oldPath?: string
  hunks: GitDiffHunk[]
  createdAt: string
  /** Captured only after the edit was verified against this HEAD. */
  baseCommit?: string
  commit?: GitCommitSummary
}
export interface PatchEvidence {
  commit?: GitCommitSummary
  uncommitted: boolean
  reverted?: boolean
}
export interface PatchHistory {
  capture(cwd: string, files: Omit<TrackedPatch, 'key' | 'createdAt'>[]): Promise<string | undefined>
  reconcile(cwd: string, patches: TrackedPatch[]): Promise<Map<string, PatchEvidence>>
}

function blocks(hunks: GitDiffHunk[]): string[][] {
  const result: string[][] = []
  for (const hunk of hunks) {
    let block: string[] = []
    for (const line of hunk.lines) {
      if (line.kind === 'add' || line.kind === 'delete') block.push(`${line.kind}:${line.text}`)
      else if (block.length) { result.push(block); block = [] }
    }
    if (block.length) result.push(block)
  }
  return result
}

/** Match reported changes, independent of context length and line shifts.
 * Never equate patches merely because they touched the same path. */
function containsPatch(raw: string, hunks: GitDiffHunk[]): boolean {
  const wanted = blocks(hunks)
  const actual = blocks(parseReviewPatch(raw))
  return wanted.length > 0 && wanted.every((block) => actual.some((candidate) =>
    candidate.some((_, start) => block.every((line, offset) => candidate[start + offset] === line))))
}

export function createPatchHistory(deps: { read(cwd: string, args: string[]): Promise<string> }): PatchHistory {
  // One shared result per checkout. Idle polling stats the recorded paths but
  // does not reload patches or walk commit history. Concurrent callers coalesce.
  const caches = new Map<string, { key: string; result: Map<string, PatchEvidence> }>()
  const pending = new Map<string, Promise<Map<string, PatchEvidence>>>()
  const head = (cwd: string) => deps.read(cwd, ['rev-parse', '--verify', 'HEAD']).then((value) => value.trim())
  const workingDiff = async (cwd: string, base: string, file: Pick<TrackedPatch, 'path' | 'oldPath'>, read = (args: string[]) => deps.read(cwd, args)) => {
    const patch = await read(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, '--', file.oldPath ?? file.path, file.path])
    if (patch.trim()) return patch
    const exists = await read(['cat-file', '-e', `${base}:${file.path}`]).then(() => true, () => false)
    if (exists) return patch
    try {
      const absolute = path.join(cwd, file.path)
      const content = (await lstat(absolute)).isSymbolicLink() ? await readlink(absolute) : await readFile(absolute, 'utf8')
      return `@@ -0,0 +1 @@\n${content.split('\n').map((line) => '+' + line).join('\n')}`
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
  }
  return {
    async capture(cwd, files) {
      try {
        const base = await head(cwd)
        // A baseline is valid only for files whose reported edit is currently
        // represented. Ingestion may race a commit or another agent's write.
        for (const file of files) if (!containsPatch(await workingDiff(cwd, base, file), file.hunks)) return
        return base
      } catch { return undefined } // Non-Git checkouts still retain agent edits.
    },
    async reconcile(cwd, patches) {
      const running = pending.get(cwd)
      if (running) { await running; return this.reconcile(cwd, patches) }
      const task = (async () => {
        const result = new Map<string, PatchEvidence>()
        if (!patches.length) return result
        let current: string
        try { current = await head(cwd) } catch { return result }
        const paths = [...new Set(patches.flatMap((file) => [file.path, ...(file.oldPath ? [file.oldPath] : [])]))].sort()
        const stamps = await Promise.all(paths.map(async (file) => {
          try { const s = await lstat(path.join(cwd, file)); return [file, s.mtimeMs, s.ctimeMs, s.size, s.ino] }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, null]; throw error }
        }))
        const index = await deps.read(cwd, ['rev-parse', '--git-path', 'index']).then((value) => stat(path.resolve(cwd, value.trim())).then((s) => [s.mtimeMs, s.ctimeMs, s.size]), () => null).catch(() => null)
        const refs = await deps.read(cwd, ['for-each-ref', '--format=%(objectname)'])
        const key = JSON.stringify([current, refs, index, patches.map((file) => file.key), stamps])
        const cached = caches.get(cwd)
        if (cached?.key === key) return cached.result
        const reads = new Map<string, Promise<string>>()
        const read = (args: string[]) => {
          const key = JSON.stringify(args)
          let promise = reads.get(key)
          if (!promise) { promise = deps.read(cwd, args); reads.set(key, promise) }
          return promise
        }
        const oldest = Math.min(...patches.map((file) => Date.parse(file.createdAt)).filter(Number.isFinite))
        for (const file of patches) {
          try {
            const args = ['--', file.oldPath ?? file.path, file.path]
            const working = await workingDiff(cwd, current, file, read)
            const staged = await read(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', current, ...args])
            const uncommitted = containsPatch(working, file.hunks) || containsPatch(staged, file.hunks)
            let commit: GitCommitSummary | undefined = file.commit
            let parent: string | undefined
            const range = file.baseCommit ? [`${file.baseCommit}..${current}`] : [current]
            const since = !file.baseCommit && Number.isFinite(oldest) ? [`--since=${new Date(oldest - 86_400_000).toISOString()}`] : []
            const log = commit ? '' : await read(['log', '--all', '--reverse', '--format=%H%x00%s%x00%cI', ...since, ...range, ...args])
            for (const entry of log.trim().split('\n').filter(Boolean)) {
              const [hash, message, date] = entry.split('\0')
              if (!file.baseCommit && Number.isFinite(Date.parse(file.createdAt)) && Date.parse(date) < Math.floor(Date.parse(file.createdAt) / 1000) * 1000) continue
              const patch = await read(['show', '--format=', '--no-ext-diff', '--no-textconv', '--no-renames', hash, ...args])
              if (!containsPatch(patch, file.hunks)) continue
              commit = { hash, message, date }
              break
            }
            if (commit && !file.baseCommit) parent = await read(['rev-parse', `${commit.hash}^`]).then((value) => value.trim()).catch(() => undefined)
            const baseline = file.baseCommit ?? parent
            // Missing evidence is retained. Only an exact return to a known
            // baseline proves this file's contribution was fully reverted.
            const reachable = commit ? await read(['merge-base', '--is-ancestor', commit.hash, current]).then(() => true, () => false) : true
            const onOtherBranch = commit && !reachable ? !!(await read(['for-each-ref', `--contains=${commit.hash}`, '--format=%(objectname)'])).trim() : false
            const ancestor = baseline && !onOtherBranch ? await read(['merge-base', '--is-ancestor', baseline, current]).then(() => true, () => false) : false
            const reverted = baseline && ancestor
              ? !(await workingDiff(cwd, baseline, file, read)).trim() && (!staged.trim() || !(await read(['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-renames', baseline, ...args])).trim())
              : false
            result.set(file.key, { ...(commit ? { commit } : {}), uncommitted: !commit && uncommitted, ...(reverted ? { reverted: true } : {}) })
          } catch {
            // Rewritten or unavailable Git history is not proof of a revert.
            result.set(file.key, { uncommitted: false })
          }
        }
        caches.set(cwd, { key, result })
        return result
      })()
      pending.set(cwd, task)
      try { return await task } finally { if (pending.get(cwd) === task) pending.delete(cwd) }
    },
  }
}
