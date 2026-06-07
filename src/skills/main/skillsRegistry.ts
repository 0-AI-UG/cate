// =============================================================================
// Skills registry — the searchable catalog the panel queries.
//
// Two feeds merged into one list:
//   - CURATED: a CI-built static `skills-index.json` (one fetch, ETag/TTL cache).
//   - USER:    live crawl of user-added repos (tree API + raw CDN, TTL cache).
// Deduped by repo+path; curated wins (it carries stars/recency from CI).
// =============================================================================

import log from '../../main/logger'
import { listSkillsInRepo, rawText } from './githubCrawl'
import { listSources, getToken } from './skillSources'
import seedIndex from '../../../registry/skills-index.json'
import type { SkillEntry } from '../../shared/skills'

const CURATED_INDEX_URL =
  process.env.CATE_SKILLS_INDEX_URL ||
  'https://raw.githubusercontent.com/0-AI-UG/cate/main/registry/skills-index.json'

const CURATED_TTL_MS = 30 * 60 * 1000
const USER_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 12000

interface IndexFile {
  generatedAt?: string
  skills?: SkillEntry[]
}

let curatedCache: { at: number; entries: SkillEntry[] } | null = null
let userCache: { at: number; entries: SkillEntry[] } | null = null

// Bundled seed — the index committed in the repo, inlined at build time. Used
// until the remote index is reachable, so curated skills work out of the box
// (dev, offline, or before the published index exists).
function seedEntries(): SkillEntry[] {
  const skills = ((seedIndex as IndexFile).skills ?? [])
  return skills.map((s) => ({ ...s, provenance: 'curated' as const }))
}

async function fetchCurated(): Promise<SkillEntry[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(CURATED_INDEX_URL, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'Cate-skills' },
      redirect: 'follow',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as IndexFile
    const skills = Array.isArray(data.skills) ? data.skills : []
    return skills.map((s) => ({ ...s, provenance: 'curated' as const }))
  } finally {
    clearTimeout(timer)
  }
}

async function loadCurated(): Promise<SkillEntry[]> {
  if (curatedCache && Date.now() - curatedCache.at < CURATED_TTL_MS) return curatedCache.entries
  try {
    const entries = await fetchCurated()
    curatedCache = { at: Date.now(), entries }
    return entries
  } catch (err) {
    // Expected when the published index isn't reachable (offline / not yet on
    // the remote). Fall back to the last good fetch, else the bundled seed —
    // and cache that for the TTL so we don't re-hit (and re-log) every call.
    const entries = curatedCache?.entries ?? seedEntries()
    log.info('[skills] curated index unavailable, using bundled seed: %s', String(err).split('\n')[0])
    curatedCache = { at: Date.now(), entries }
    return entries
  }
}

async function loadUserLive(): Promise<SkillEntry[]> {
  if (userCache && Date.now() - userCache.at < USER_TTL_MS) return userCache.entries
  const sources = listSources()
  const token = getToken()
  const all: SkillEntry[] = []
  for (const src of sources) {
    try {
      all.push(...(await listSkillsInRepo(src, token)))
    } catch (err) {
      log.warn('[skills] live crawl failed for %s: %O', src.repo, err)
    }
  }
  userCache = { at: Date.now(), entries: all }
  return all
}

function dedupeKey(e: SkillEntry): string {
  return `${e.source.repo.toLowerCase()}#${e.source.path}`
}

/** Curated ∪ live user repos, deduped (curated wins). */
export async function getMergedIndex(): Promise<SkillEntry[]> {
  const [curated, user] = await Promise.all([loadCurated(), loadUserLive()])
  const seen = new Set<string>()
  const out: SkillEntry[] = []
  for (const e of [...curated, ...user]) {
    const k = dedupeKey(e)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(e)
  }
  return out
}

export function refresh(): void {
  curatedCache = null
  userCache = null
}

/** Fetch a skill's SKILL.md body for the detail preview (on demand). */
export async function getPreview(entry: SkillEntry): Promise<string> {
  const ref = entry.source.ref || 'main'
  const path = entry.source.path ? `${entry.source.path.replace(/\/+$/, '')}/SKILL.md` : 'SKILL.md'
  return rawText(entry.source.repo, ref, path, getToken())
}
