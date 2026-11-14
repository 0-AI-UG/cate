// Read-only view data shared across overlay mounts. A previous result can be
// displayed immediately; the caller's status revision decides when to reload.
import type { CapabilityProxy, ParamsOf, ResultOf } from '@kernel/rpc/contract'
import type { GitFileDiff, VcsCapability } from '../contract'

type Method = 'compare' | 'fileDiff' | 'fileContent' | 'findRepos' | 'remotes' | 'log'
type Methods = VcsCapability['methods']
type Args<K extends Method> = ParamsOf<Methods[K]>
type Result<K extends Method> = ResultOf<Methods[K]>
type Entry = { value?: unknown; revision?: string; pending?: Promise<unknown>; pendingRevision?: string; bytes: number }

const cacheKey = (method: Method, args: unknown) => JSON.stringify([method, args], (_key, value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value)

function estimateBytes(value: unknown): number {
  const diff = value as Partial<GitFileDiff> | null
  if (diff?.hunks) return 256 + diff.hunks.reduce((sum, hunk) => sum + hunk.header.length * 2 + hunk.lines.reduce((sum, line) => sum + line.text.length * 2 + 96, 0), 0)
  return JSON.stringify(value).length * 2
}

/** Bounded to 128 reads / 32 MiB per connected runtime; failures are not cached. */
export function createRepositoryReadCache(vcs: Pick<CapabilityProxy<VcsCapability>, Method>, maxBytes = 32 * 1024 * 1024) {
  const entries = new Map<string, Entry>()
  let bytes = 0
  const touch = (key: string, entry: Entry) => { entries.delete(key); entries.set(key, entry) }
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= maxBytes && entries.size <= 128) break
      if (entry.pending) continue
      bytes -= entry.bytes
      entries.delete(key)
    }
  }
  return {
    peek<K extends Method>(method: K, args: Args<K>): Result<K> | undefined {
      const key = cacheKey(method, args)
      const entry = entries.get(key)
      if (entry) touch(key, entry)
      return entry?.value as Result<K> | undefined
    },
    read<K extends Method>(method: K, args: Args<K>, revision?: string): Promise<Result<K>> {
      const key = cacheKey(method, args)
      const entry = entries.get(key) ?? { bytes: 0 }
      touch(key, entry)
      if (revision !== undefined && entry.value !== undefined && entry.revision === revision) return Promise.resolve(entry.value as Result<K>)
      if (entry.pending && entry.pendingRevision === revision) return entry.pending as Promise<Result<K>>
      const run = vcs[method] as unknown as (args: Args<K>) => Promise<Result<K>>
      const pending = run(args).then((value) => {
        if (entry.pending === pending) {
          bytes -= entry.bytes
          entry.value = value
          entry.bytes = estimateBytes(value)
          bytes += entry.bytes
          entry.revision = revision
        }
        return value
      }).finally(() => {
        if (entry.pending === pending) {
          entry.pending = undefined
          entry.pendingRevision = undefined
          trim()
        }
      })
      entry.pending = pending
      entry.pendingRevision = revision
      return pending
    },
  }
}

export type RepositoryReadCache = ReturnType<typeof createRepositoryReadCache>
