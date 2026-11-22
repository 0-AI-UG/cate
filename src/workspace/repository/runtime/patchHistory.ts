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
function containsBlocks(actual: string[][], hunks: GitDiffHunk[]): boolean {
  const wanted = blocks(hunks)
  return wanted.length > 0 && wanted.every((block) => actual.some((candidate) =>
    candidate.some((_, start) => block.every((line, offset) => candidate[start + offset] === line))))
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames']
const DIFF_BATCH_SIZE = 128
const HISTORY_BATCH_MIN = 8

function filePaths(file: Pick<TrackedPatch, 'path' | 'oldPath'>): string[] {
  return file.oldPath && file.oldPath !== file.path ? [file.oldPath, file.path].sort() : [file.path]
}

/** With renames disabled, the NUL-delimited raw paths precede the patches in
 * the same order. Use the raw names so spaces, quotes and newlines stay literal. */
function diffByPath(raw: string): Map<string, string> {
  if (!raw) return new Map()
  const boundary = raw.indexOf('\0\0')
  const entries = raw.slice(0, boundary).split('\0')
  const patches = raw.slice(boundary + 2).split(/\n(?=diff --git )/)
  // Unmerged paths and type changes can emit a different number of patches
  // than raw entries, so they use the path-specific fallback.
  if (boundary < 0 || entries.length !== patches.length * 2 || !patches[0].startsWith('diff --git ') ||
      entries.some((entry, index) => index % 2 === 0 && !/^:[^\n]+ [ADM]$/.test(entry))) {
    throw new Error('Unexpected format for batched Git diff')
  }
  return new Map(patches.map((patch, index) => [entries[index * 2 + 1], patch + '\n']))
}

async function untrackedPatch(absolute: string): Promise<string> {
  try {
    const content = (await lstat(absolute)).isSymbolicLink() ? await readlink(absolute) : await readFile(absolute, 'utf8')
    return `@@ -0,0 +1 @@\n${content.split('\n').map((line) => '+' + line).join('\n')}`
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}

export function createPatchHistory(deps: { read(cwd: string, args: string[]): Promise<string> }): PatchHistory {
  // One shared result per checkout. Idle polling stats the recorded paths but
  // does not reload patches or walk commit history. Concurrent callers coalesce.
  const caches = new Map<string, { key: string; result: Map<string, PatchEvidence> }>()
  const pending = new Map<string, Promise<Map<string, PatchEvidence>>>()
  const head = (cwd: string) => deps.read(cwd, ['rev-parse', '--verify', 'HEAD']).then((value) => value.trim())
  const workingDiff = async (cwd: string, base: string, file: Pick<TrackedPatch, 'path' | 'oldPath'>, read = (args: string[]) => deps.read(cwd, args)) => {
    const patch = await read(['--literal-pathspecs', 'diff', ...DIFF_FLAGS, base, '--', ...filePaths(file)])
    if (patch.trim()) return patch
    const exists = await read(['cat-file', '-e', `${base}:${file.path}`]).then(() => true, () => false)
    if (exists) return patch
    return untrackedPatch(path.join(cwd, file.path))
  }
  return {
    async capture(cwd, files) {
      try {
        const base = await head(cwd)
        // A baseline is valid only for files whose reported edit is currently
        // represented. Ingestion may race a commit or another agent's write.
        for (const file of files) if (!containsBlocks(blocks(parseReviewPatch(await workingDiff(cwd, base, file))), file.hunks)) return
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
        const paths = [...new Set(patches.flatMap(filePaths))].sort()
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
        const workingPatches = new Map<string, string>()
        const stagedPatches = new Map<string, string>()
        const batched = new Set<string>()
        const present = new Set(stamps.filter((stamp) => stamp[1] !== null).map(([file]) => file))
        for (let start = 0; start < paths.length; start += DIFF_BATCH_SIZE) {
          const batch = paths.slice(start, start + DIFF_BATCH_SIZE)
          const diff = (mode: string[]) => read(['--literal-pathspecs', 'diff', ...mode, ...DIFF_FLAGS,
            '--no-color', '--submodule=short', '--raw', '-z', '--patch', current, '--', ...batch]).then(diffByPath)
          try {
            const [working, staged] = await Promise.all([diff([]), diff(['--cached'])])
            const requested = new Set(batch)
            if ([...working.keys(), ...staged.keys()].some((name) => !requested.has(name))) continue
            const unchanged = batch.filter((file) => present.has(file) && !working.has(file))
            if (unchanged.length) {
              const tracked = new Set((await read(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', current, '--', ...unchanged])).split('\0'))
              const untracked = unchanged.filter((file) => !tracked.has(file))
              // An unavailable working file leaves this batch on the per-file path.
              const content = await Promise.all(untracked.map((file) => untrackedPatch(path.join(cwd, file))))
              untracked.forEach((file, index) => { if (content[index]) working.set(file, content[index]) })
            }
            for (const [file, patch] of working) workingPatches.set(file, patch)
            for (const [file, patch] of staged) stagedPatches.set(file, patch)
            for (const file of batch) batched.add(file)
          } catch { /* Preserve per-file evidence if this Git output cannot be batched. */ }
        }
        const forFile = (diffs: Map<string, string>, paths: string[]) => paths.map((name) => diffs.get(name) ?? '').join('')
        let oldest = Infinity
        for (const file of patches) {
          const date = Date.parse(file.createdAt)
          if (Number.isFinite(date)) oldest = Math.min(oldest, date)
        }
        // --all can include other branches even when the captured baseline is HEAD.
        const onlyCurrentRef = refs.trim().split('\n').every((ref) => !ref || ref === current)
        const rangeFor = (base?: string) => base ? [`${base}..${current}`] : [current]
        const sinceFor = (base?: string, option = '--since') => !base && Number.isFinite(oldest)
          ? [`${option}=${new Date(oldest - 86_400_000).toISOString()}`] : []
        const pathsByBase = new Map<string | undefined, Set<string>>()
        for (const file of patches) {
          if (file.commit || (file.baseCommit === current && onlyCurrentRef)) continue
          let names = pathsByBase.get(file.baseCommit)
          if (!names) { names = new Set(); pathsByBase.set(file.baseCommit, names) }
          for (const name of filePaths(file)) names.add(name)
        }
        const noHistory = new Map<string | undefined, Set<string>>()
        for (const [base, names] of pathsByBase) {
          if (names.size < HISTORY_BATCH_MIN) continue
          const paths = [...names].sort()
          const absent = new Set<string>()
          noHistory.set(base, absent)
          for (let start = 0; start < paths.length; start += DIFF_BATCH_SIZE) {
            const batch = paths.slice(start, start + DIFF_BATCH_SIZE)
            try {
              // Only use this walk to exclude paths. Full history and separate
              // merge diffs give a superset of the path-specific commit walk.
              const raw = await read(['--literal-pathspecs', 'log', '--all', '--full-history', '-m', '--format=',
                '--name-only', '-z', '--no-color', '--no-show-signature', ...DIFF_FLAGS,
                ...sinceFor(base, '--since-as-filter'), ...rangeFor(base), '--', ...batch])
              const changed = raw.split('\0').filter(Boolean)
              const requested = new Set(batch)
              const touched = new Set<string>()
              let valid = true
              for (const name of changed) {
                let matched = requested.has(name)
                if (matched) touched.add(name)
                for (let slash = name.lastIndexOf('/'); slash > 0; slash = name.lastIndexOf('/', slash - 1)) {
                  const parent = name.slice(0, slash)
                  if (requested.has(parent)) { matched = true; touched.add(parent) }
                }
                if (!matched) { valid = false; break }
              }
              if (valid) for (const name of batch) if (!touched.has(name)) absent.add(name)
            } catch { /* Try the original path-specific history below. */ }
          }
        }
        const parsed = new Map<string, string[][]>()
        const matches = (raw: string, hunks: GitDiffHunk[]) => {
          if (!raw) return false
          let actual = parsed.get(raw)
          if (!actual) { actual = blocks(parseReviewPatch(raw)); parsed.set(raw, actual) }
          return containsBlocks(actual, hunks)
        }
        for (const file of patches) {
          try {
            const names = filePaths(file)
            const args = ['--', ...names]
            const inBatch = names.every((name) => batched.has(name))
            const working = inBatch ? forFile(workingPatches, names) : await workingDiff(cwd, current, file, read)
            const staged = inBatch ? forFile(stagedPatches, names) : await read(['--literal-pathspecs', 'diff', '--cached', ...DIFF_FLAGS, current, ...args])
            const uncommitted = matches(working, file.hunks) || matches(staged, file.hunks)
            let commit: GitCommitSummary | undefined = file.commit
            let parent: string | undefined
            const absent = noHistory.get(file.baseCommit)
            const log = commit || (file.baseCommit === current && onlyCurrentRef) || names.every((name) => absent?.has(name)) ? ''
              : await read(['--literal-pathspecs', 'log', '--all', '--reverse', '--format=%H%x00%s%x00%cI',
                ...sinceFor(file.baseCommit), ...rangeFor(file.baseCommit), ...args])
            for (const entry of log.trim().split('\n').filter(Boolean)) {
              const [hash, message, date] = entry.split('\0')
              if (!file.baseCommit && Number.isFinite(Date.parse(file.createdAt)) && Date.parse(date) < Math.floor(Date.parse(file.createdAt) / 1000) * 1000) continue
              const patch = await read(['--literal-pathspecs', 'show', '--format=', ...DIFF_FLAGS, hash, ...args])
              if (!matches(patch, file.hunks)) continue
              commit = { hash, message, date }
              break
            }
            if (commit && !file.baseCommit) parent = await read(['rev-parse', `${commit.hash}^`]).then((value) => value.trim()).catch(() => undefined)
            const baseline = file.baseCommit ?? parent
            // Missing evidence is retained. Only an exact return to a known
            // baseline proves this file's contribution was fully reverted.
            const reachable = commit ? await read(['merge-base', '--is-ancestor', commit.hash, current]).then(() => true, () => false) : true
            const onOtherBranch = commit && !reachable ? !!(await read(['for-each-ref', `--contains=${commit.hash}`, '--format=%(objectname)'])).trim() : false
            const ancestor = baseline && !onOtherBranch && (baseline === current ||
              await read(['merge-base', '--is-ancestor', baseline, current]).then(() => true, () => false))
            const reverted = baseline && ancestor
              ? !(baseline === current ? working : await workingDiff(cwd, baseline, file, read)).trim()
                && (!staged.trim() || (baseline !== current && !(await read(['--literal-pathspecs', 'diff', '--cached', ...DIFF_FLAGS, baseline, ...args])).trim()))
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
