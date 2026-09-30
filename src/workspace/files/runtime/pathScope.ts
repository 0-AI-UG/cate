// The path scope of one workspace runtime (architecture 7.1): every path a
// capability touches must lie in the workspace root, one of its worktree
// checkouts, the workspace data directory or a granted path. There are no scope
// ids: the connection is the scope, and the daemon serves one workspace.

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { dataPaths } from '@runtime/data/runtime'

export interface PathScope {
  readonly root: string
  readonly dataDir: string
  /** Lexical check (no filesystem access). Returns the resolved path. */
  resolve(p: string): string
  /** A working directory for a process; lexical like `resolve`. */
  cwd(p: string): string
  /** Resolves symlinks (a missing tail stays literal) and checks the real path.
   *  For reads and anything that follows the path. */
  strict(p: string): Promise<string>
  /** For creating or writing `p`: the parent chain is resolved, the final
   *  segment must not be an existing symlink. Returns realParent + basename. */
  forCreation(p: string): Promise<string>
  /** For operating on the entry itself (remove, rename source) without
   *  following a final symlink. */
  entry(p: string): Promise<string>
  /** True when `p` (already resolved) is inside the scope. */
  contains(p: string): boolean
  /** Hook for the repository module: a worktree checkout outside the root. */
  addCheckout(p: string): void
  removeCheckout(p: string): void
  checkouts(): string[]
  /** Grants a path the user picked outside the workspace; persisted in
   *  `<data>/grants.json`. A granted directory covers its contents. */
  grant(p: string): Promise<string>
  revokeGrant(p: string): Promise<void>
  grants(): string[]
  dispose(): void
}

export interface PathScopeOptions {
  /** Canonical workspace root. */
  root: string
  /** The workspace data directory. */
  dataDir: string
  platform?: NodeJS.Platform
}

/** Where worktree checkouts of the workspace live. */
export function worktreesDir(root: string): string {
  return path.join(root, '.cate', 'worktrees')
}

export function pathCompareKey(p: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? p.toLowerCase() : p
}

/** Strips the Windows long-path prefix a native realpath may add, so it
 *  compares with `path.resolve` output. */
function normalizeForComparison(p: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return p
  if (p.startsWith('\\\\?\\UNC\\')) return '\\' + p.slice(7)
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

// A root must match both the lexical form and the symlink-free form strict
// checks produce: macOS /tmp is a symlink to /private/tmp, and Windows short
// names expand under the native realpath.
function canonicalForms(resolved: string, platform: NodeJS.Platform): string[] {
  const forms = new Set([resolved, normalizeForComparison(resolved, platform)])
  try {
    let real: string
    try {
      real = fsSync.realpathSync.native(resolved)
    } catch {
      // The native resolver fails on some WinFsp mounts; the JS one works.
      real = fsSync.realpathSync(resolved)
    }
    forms.add(real)
    forms.add(normalizeForComparison(real, platform))
  } catch {
    // Missing root: lexical form only.
  }
  return [...forms]
}

function keyUnder(key: string, root: string, platform: NodeJS.Platform): boolean {
  const rootKey = pathCompareKey(root, platform)
  // Filesystem roots (Z:\, /) already end with a separator.
  const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep
  return key === rootKey || key.startsWith(prefix)
}

const MAX_PARENT_TRAVERSALS = 256

async function realpathWithFallback(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err
    return fsSync.realpathSync(target)
  }
}

/** Realpath of `target`, tolerating a missing tail: the nearest existing
 *  ancestor is resolved and the rest re-appended. Every existing segment is
 *  resolved, so a symlink out of the scope is still caught. */
export async function realpathAllowingMissing(target: string): Promise<string> {
  const resolved = path.resolve(target)
  const missing: string[] = []
  let cur = resolved
  for (let attempts = 0; ; attempts++) {
    try {
      const real = await realpathWithFallback(cur)
      return missing.length ? path.join(real, ...missing) : real
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const parent = path.dirname(cur)
    if (parent === cur) return resolved
    missing.unshift(path.basename(cur))
    cur = parent
    if (attempts + 1 >= MAX_PARENT_TRAVERSALS) {
      throw new Error(`Too many missing path segments while resolving "${target}"`)
    }
  }
}

function denied(message: string): RpcError {
  return new RpcError('rejected', `Access denied: ${message}`)
}

async function creationTarget(p: string): Promise<string> {
  const parent = path.dirname(path.resolve(p))
  const base = path.basename(p)
  if (!base || base === '.' || base === '..' || base.includes('\0')) throw denied(`invalid entry name "${base}"`)
  let realParent: string
  try {
    realParent = await realpathAllowingMissing(parent)
  } catch (err) {
    throw denied(`cannot resolve real path for parent "${parent}": ${err}`)
  }
  return path.join(realParent, base)
}

export function createPathScope(options: PathScopeOptions): PathScope {
  const platform = options.platform ?? process.platform
  const root = path.resolve(options.root)
  const dataDir = path.resolve(options.dataDir)
  const fixedForms = [
    ...canonicalForms(root, platform),
    ...canonicalForms(worktreesDir(root), platform),
    ...canonicalForms(dataDir, platform),
  ]
  const checkoutForms = new Map<string, string[]>()
  const grantsFile: JsonStateFile<string[]> = createJsonStateFile<string[]>({
    file: dataPaths(dataDir).grants,
    defaults: [],
    normalize: (parsed) => Array.isArray(parsed)
      ? [...new Set(parsed.filter((v): v is string => typeof v === 'string' && path.isAbsolute(v)))]
      : [],
  })
  grantsFile.load()
  let grantForms = new Map<string, string[]>()
  const refreshGrants = (list: string[]): void => {
    const next = new Map<string, string[]>()
    for (const p of list) next.set(p, grantForms.get(p) ?? canonicalForms(p, platform))
    grantForms = next
  }
  refreshGrants(grantsFile.get())
  const stopGrants = grantsFile.subscribe((list) => refreshGrants(list))

  const within = (p: string): boolean => {
    const candidates = new Set([pathCompareKey(p, platform), pathCompareKey(normalizeForComparison(p, platform), platform)])
    for (const key of candidates) {
      if (fixedForms.some((f) => keyUnder(key, f, platform))) return true
      for (const forms of checkoutForms.values()) if (forms.some((f) => keyUnder(key, f, platform))) return true
      for (const forms of grantForms.values()) if (forms.some((f) => keyUnder(key, f, platform))) return true
    }
    return false
  }

  const resolve = (p: string): string => {
    if (!p || typeof p !== 'string') throw denied('invalid path')
    const normalized = path.resolve(p)
    if (!within(normalized)) throw denied(`path "${p}" is outside the workspace`)
    return normalized
  }

  return {
    root,
    dataDir,
    resolve,
    cwd: resolve,
    contains: within,

    async strict(p) {
      resolve(p)
      let real: string
      try {
        real = await realpathAllowingMissing(p)
      } catch (err) {
        throw denied(`cannot resolve real path for "${p}": ${err}`)
      }
      if (!within(real)) throw denied(`resolved path "${real}" is outside the workspace`)
      return real
    },

    async forCreation(p) {
      const target = await creationTarget(p)
      // The final segment is not resolved, so an existing symlink there would
      // let a write follow it out of the scope.
      const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null
        throw err
      })
      if (stat?.isSymbolicLink()) throw denied(`"${p}" is a symbolic link`)
      // Only the resolved form counts: accepting the lexical one would undo the
      // parent resolution for a symlinked directory inside the root.
      if (!within(target)) throw denied(`resolved parent "${path.dirname(target)}" is outside the workspace`)
      return target
    },

    async entry(p) {
      resolve(p)
      return resolve(await creationTarget(p))
    },

    addCheckout(p) {
      const resolved = path.resolve(p)
      checkoutForms.set(resolved, canonicalForms(resolved, platform))
    },
    removeCheckout(p) {
      checkoutForms.delete(path.resolve(p))
    },
    checkouts: () => [...checkoutForms.keys()],

    async grant(p) {
      const target = await creationTarget(p)
      const current = grantsFile.get()
      if (!current.includes(target)) {
        grantsFile.set([...current, target])
        refreshGrants(grantsFile.get())
        await grantsFile.flushDurable()
      }
      return target
    },
    async revokeGrant(p) {
      const target = await creationTarget(p).catch(() => path.resolve(p))
      const next = grantsFile.get().filter((g) => g !== target && g !== path.resolve(p))
      grantsFile.set(next)
      refreshGrants(next)
      await grantsFile.flushDurable()
    },
    grants: () => [...grantsFile.get()],

    dispose() {
      stopGrants()
      grantsFile.dispose()
    },
  }
}
