// The `skills` capability: installs into the workspace's agent dirs, the
// manifest `<root>/.cate/skills.json`, worktree mirrors, the workspace's skill
// sources, the catalog (bundled, curated, crawled) and bundled-skill seeding.

import path from 'node:path'
import { createLogger, type Logger } from '@kernel/log/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl } from '@kernel/rpc/runtime'
import type {
  InstalledSkill,
  SkillEntry,
  SkillFile,
  SkillInstallResult,
  SkillMirrorSyncResult,
  SkillSource,
  SkillTarget,
  SkillTargetId,
  skillsCapability,
} from '../contract'
import { listBundledSkills, readBundledSkill } from './bundled'
import { createDirLocks, dirKey, nodeSkillFiles, type SkillFiles } from './files'
import { fetchSkillFiles, type FetchLike } from './githubCrawl'
import { createSkillInstaller } from './installer'
import { createSkillMirror } from './mirror'
import { createSkillsRegistry } from './registry'
import { createSkillSeeder } from './seed'
import { openSkillSources } from './sources'
import { createTargetTable } from './targets'

export interface SkillsTrust {
  isTrusted(): boolean
  /** Throws `RpcError('untrusted')`. */
  requireTrusted(): void
}

export interface SkillsRuntimeDeps {
  /** Canonical workspace root. */
  root: string
  dataPaths: { skillSources: string }
  trust: SkillsTrust
  /** Install targets, derived from the agent registry by the composition root. */
  targets: readonly SkillTarget[]
  /** The runtime tarball's `skills/` dir (`cate-cli/`, `cate-theme/`). */
  bundledSkillsDir?: string
  fetch?: FetchLike
  /** GitHub token for the crawl (lifts the rate limit, reaches private repos). */
  githubToken?: () => Promise<string | undefined>
  /** Worktree checkouts that mirror the root's skills. */
  listCheckouts?: () => Promise<string[]>
  ensureCateGitignore?: (cateDir: string) => Promise<void>
  indexUrl?: string
  log?: Logger
  /** Tests swap in an in-memory filesystem. */
  files?: SkillFiles
}

export type SkillsRuntime = ReturnType<typeof createSkillsRuntime>

export function createSkillsRuntime(deps: SkillsRuntimeDeps) {
  const { root, trust } = deps
  const files = deps.files ?? nodeSkillFiles
  const log = deps.log ?? createLogger('skills')
  const fetchImpl: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const githubToken = deps.githubToken ?? (async () => undefined)
  const targets = createTargetTable(deps.targets)
  const withDirs = createDirLocks()
  const installer = createSkillInstaller({ files, targets, withDirs })
  const mirror = createSkillMirror({ files, targets, withDirs, log, ensureCateGitignore: deps.ensureCateGitignore })
  const seeder = createSkillSeeder({ files, targets, installer, withDirs, bundledSkillsDir: deps.bundledSkillsDir, log })
  const sources = openSkillSources(deps.dataPaths.skillSources)
  const bundled = () => listBundledSkills(files, deps.bundledSkillsDir)
  const registry = createSkillsRegistry({
    fetch: fetchImpl,
    githubToken,
    sources: () => sources.list(),
    bundled,
    indexUrl: deps.indexUrl,
    log,
  })

  function requireTarget(targetId: unknown): SkillTargetId {
    if (!targets.isKnown(targetId)) throw new RpcError('rejected', `Unknown skill target: ${String(targetId)}`)
    return targetId
  }

  async function syncCheckouts(): Promise<string[]> {
    if (!deps.listCheckouts) return []
    try {
      const checkouts = await deps.listCheckouts()
      const results = await Promise.all(checkouts.map((checkout) => mirror.sync(root, checkout)))
      return results.flatMap((result) => result.warnings)
    } catch (err) {
      log.warn('worktree sync failed: %O', err)
      return []
    }
  }

  /** The bundle for an entry: the runtime's own copy for a bundled skill,
   *  else the source (authoritative), else another agent's install here. */
  async function resolveFiles(entry: SkillEntry): Promise<{ files: SkillFile[]; offline: boolean }> {
    const own = (await bundled()).find((b) => b.id === entry.id)
    if (own && deps.bundledSkillsDir) {
      return { files: await readBundledSkill(files, deps.bundledSkillsDir, path.posix.basename(own.source.path)), offline: false }
    }
    let fetchError: unknown
    if (entry.source.repo) {
      try {
        const fetched = await fetchSkillFiles(entry.source, { fetch: fetchImpl, token: await githubToken() })
        if (fetched.length) return { files: fetched, offline: false }
        throw new Error('Source returned no skill files')
      } catch (err) {
        fetchError = err
      }
    }
    const existing = (await installer.readManifest(root)).find((m) => m.skillId === entry.id)
    const fallback = existing ? await installer.readWorkspaceSkillFiles(root, existing.targetId, existing.name) : []
    if (fallback.length) return { files: fallback, offline: true }
    if (fetchError instanceof Error) throw fetchError
    throw new Error('Could not resolve skill files')
  }

  return {
    targets: (): SkillTarget[] => [...targets.list],

    async index(refresh = false): Promise<SkillEntry[]> {
      if (refresh) registry.refresh()
      try {
        return await registry.getMergedIndex()
      } catch (err) {
        log.warn('index failed: %O', err)
        return []
      }
    },

    preview: (entry: SkillEntry): Promise<string> => registry.getPreview(entry),

    listInstalled: (): Promise<InstalledSkill[]> => installer.readManifest(root),

    async install(entry: SkillEntry, targetId: SkillTargetId): Promise<SkillInstallResult> {
      trust.requireTrusted()
      requireTarget(targetId)
      const resolved = await resolveFiles(entry)
      const result = await installer.writeSkill({ skillId: entry.id, name: entry.name, targetId, cwd: root, files: resolved.files })
      if (resolved.offline) result.warnings.unshift('Latest source unavailable; installed the existing offline copy.')
      result.warnings.push(...await syncCheckouts())
      return result
    },

    async uninstall(skillId: string, targetId: SkillTargetId): Promise<{ warnings: string[] }> {
      trust.requireTrusted()
      requireTarget(targetId)
      await installer.uninstall(skillId, targetId, root)
      return { warnings: await syncCheckouts() }
    },

    async reinstallBundled(name: string): Promise<{ installedTargets: number; warnings: string[] }> {
      trust.requireTrusted()
      if (!(await bundled()).some((b) => path.posix.basename(b.source.path) === name)) {
        throw new RpcError('rejected', `No bundled skill named ${name}`)
      }
      const installedTargets = await seeder.reinstall(root, name)
      return { installedTargets, warnings: await syncCheckouts() }
    },

    /** Seeds the bundled skills into targets whose tool dir exists. The
     *  composition root calls this at open (gated by `cliSkillInstallEnabled`)
     *  and after trust is granted; untrusted, it does nothing. */
    async seedBundled(names?: readonly string[]): Promise<void> {
      if (!trust.isTrusted()) return
      const all = (await bundled()).map((b) => path.posix.basename(b.source.path))
      await seeder.seed(root, names ? all.filter((n) => names.includes(n)) : all)
      await syncCheckouts()
    },

    async syncCheckout(checkout: string): Promise<SkillMirrorSyncResult> {
      trust.requireTrusted()
      if (deps.listCheckouts) {
        const known = (await deps.listCheckouts()).map(dirKey)
        if (!known.includes(dirKey(checkout))) throw new RpcError('rejected', 'Not a worktree checkout of this workspace')
      }
      return mirror.sync(root, checkout)
    },

    listSources: (): SkillSource[] => sources.list(),

    addSource(repo: string, opts?: { ref?: string; path?: string }): SkillSource {
      let source: SkillSource
      try {
        source = sources.add(repo, opts)
      } catch (err) {
        throw new RpcError('rejected', err instanceof Error ? err.message : String(err))
      }
      registry.refresh()
      return source
    },

    removeSource(id: string): void {
      sources.remove(id)
      registry.refresh()
    },

    async dispose(): Promise<void> {
      await sources.file.flush()
      sources.file.dispose()
    },
  }
}

export function skillsCapabilityImpl(service: SkillsRuntime): CapabilityImpl<typeof skillsCapability> {
  return {
    targets: () => service.targets(),
    index: (params) => service.index(params?.refresh === true),
    preview: ({ entry }) => service.preview(entry),
    listInstalled: () => service.listInstalled(),
    install: ({ entry, targetId }) => service.install(entry, targetId),
    uninstall: ({ skillId, targetId }) => service.uninstall(skillId, targetId),
    reinstallBundled: ({ name }) => service.reinstallBundled(name),
    syncCheckout: ({ checkout }) => service.syncCheckout(checkout),
    listSources: () => service.listSources(),
    addSource: ({ repo, ref, path: subdir }) => service.addSource(repo, { ref, path: subdir }),
    removeSource: ({ id }) => service.removeSource(id),
  }
}
