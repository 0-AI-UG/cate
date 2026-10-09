// The catalog: skills bundled with the runtime, the curated index (a CI-built
// `skills-index.json`, cached) and a live crawl of the workspace's sources.
// Deduplicated by repo and path; earlier feeds win.

import type { Logger } from '@kernel/log/contract'
import seedIndex from '../../../../registry/skills-index.json'
import type { SkillEntry, SkillSource } from '../contract'
import { fetchWithTimeout, listSkillsInRepo, rawText, type FetchLike } from './githubCrawl'

export const CURATED_INDEX_URL = 'https://raw.githubusercontent.com/0-AI-UG/cate/main/registry/skills-index.json'

const CURATED_TTL_MS = 30 * 60 * 1000
const USER_TTL_MS = 10 * 60 * 1000

interface IndexFile {
  generatedAt?: string
  skills?: SkillEntry[]
}

export interface SkillsRegistryDeps {
  fetch: FetchLike
  githubToken: () => Promise<string | undefined>
  sources: () => SkillSource[]
  bundled: () => Promise<SkillEntry[]>
  indexUrl?: string
  log: Logger
  now?: () => number
}

export function createSkillsRegistry(deps: SkillsRegistryDeps) {
  const now = deps.now ?? Date.now
  const indexUrl = deps.indexUrl ?? CURATED_INDEX_URL
  let curatedCache: { at: number; entries: SkillEntry[] } | null = null
  let userCache: { at: number; entries: SkillEntry[]; token: string | undefined } | null = null

  // The index committed in the repo, used until the remote one is reachable,
  // so curated skills work offline.
  const seedEntries = (): SkillEntry[] =>
    ((seedIndex as IndexFile).skills ?? []).map((s) => ({ ...s, provenance: 'curated' as const }))

  async function fetchCurated(): Promise<SkillEntry[]> {
    const res = await fetchWithTimeout(deps.fetch, indexUrl, { 'Accept': 'application/json', 'User-Agent': 'Cate-skills' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as IndexFile
    return (Array.isArray(data.skills) ? data.skills : []).map((s) => ({ ...s, provenance: 'curated' as const }))
  }

  async function loadCurated(): Promise<SkillEntry[]> {
    if (curatedCache && now() - curatedCache.at < CURATED_TTL_MS) return curatedCache.entries
    try {
      const entries = await fetchCurated()
      curatedCache = { at: now(), entries }
      return entries
    } catch (err) {
      // Cache the fallback for the TTL so we don't re-hit (and re-log) each call.
      const entries = curatedCache?.entries ?? seedEntries()
      deps.log.info('curated index unavailable, using bundled seed: %s', String(err).split('\n')[0])
      curatedCache = { at: now(), entries }
      return entries
    }
  }

  async function loadUserLive(): Promise<SkillEntry[]> {
    const sources = deps.sources()
    if (!sources.length) return []
    const token = await deps.githubToken()
    if (userCache && userCache.token === token && now() - userCache.at < USER_TTL_MS) return userCache.entries
    const all: SkillEntry[] = []
    for (const src of sources) {
      try {
        all.push(...(await listSkillsInRepo(src, { fetch: deps.fetch, token })))
      } catch (err) {
        deps.log.warn('live crawl failed for %s: %O', src.repo, err)
      }
    }
    userCache = { at: now(), entries: all, token }
    return all
  }

  const dedupeKey = (e: SkillEntry): string => `${e.source.repo.toLowerCase()}#${e.source.path}`

  async function getMergedIndex(): Promise<SkillEntry[]> {
    const [bundled, curated, user] = await Promise.all([deps.bundled(), loadCurated(), loadUserLive()])
    const seen = new Set<string>()
    const out: SkillEntry[] = []
    for (const e of [...bundled, ...curated, ...user]) {
      const k = dedupeKey(e)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(e)
    }
    return out
  }

  function refresh(): void {
    curatedCache = null
    userCache = null
  }

  /** A skill's SKILL.md body for the detail preview. */
  async function getPreview(entry: SkillEntry): Promise<string> {
    const ref = entry.source.ref || 'main'
    const filePath = entry.source.path ? `${entry.source.path.replace(/\/+$/, '')}/SKILL.md` : 'SKILL.md'
    return rawText(entry.source.repo, ref, filePath, { fetch: deps.fetch, token: await deps.githubToken() })
  }

  return { getMergedIndex, refresh, getPreview }
}
