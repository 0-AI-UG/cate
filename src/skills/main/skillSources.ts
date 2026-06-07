// =============================================================================
// Skill sources — userData list of user-added repos to live-crawl, plus an
// optional GitHub token (lifts the 60/hr REST limit and reaches private repos).
// The curated catalog comes from the CI-built index; this is the user's own
// additions on top.
// =============================================================================

import { randomUUID } from 'crypto'
import { createJsonStateFile } from '../../main/jsonStateFile'
import { parseRepo } from './githubCrawl'
import type { SkillSource } from '../../shared/skills'

interface SkillSourcesState {
  sources: SkillSource[]
  githubToken?: string
}

const DEFAULTS: SkillSourcesState = { sources: [] }

const store = createJsonStateFile<SkillSourcesState>({
  filename: 'skill-sources.json',
  defaults: DEFAULTS,
  normalize: (parsed, defaults) => {
    if (!parsed || typeof parsed !== 'object') return defaults
    const obj = parsed as Partial<SkillSourcesState>
    const sources = Array.isArray(obj.sources)
      ? obj.sources.filter(
          (s): s is SkillSource =>
            !!s && typeof s === 'object' &&
            typeof (s as SkillSource).id === 'string' &&
            typeof (s as SkillSource).repo === 'string',
        )
      : []
    const githubToken = typeof obj.githubToken === 'string' && obj.githubToken ? obj.githubToken : undefined
    return githubToken ? { sources, githubToken } : { sources }
  },
})

let loaded = false
function ensureLoaded(): void {
  if (!loaded) {
    store.load()
    loaded = true
  }
}

export function listSources(): SkillSource[] {
  ensureLoaded()
  return store.get().sources
}

export function getToken(): string | undefined {
  ensureLoaded()
  return store.get().githubToken
}

export function setToken(token: string | undefined): void {
  ensureLoaded()
  store.update((cur) => {
    const next = { ...cur }
    if (token && token.trim()) next.githubToken = token.trim()
    else delete next.githubToken
    return next
  })
}

/** Add a repo by "owner/name" or GitHub URL. Returns the created source. Throws
 *  on an invalid repo string. */
export function addSource(repo: string, opts?: { ref?: string; path?: string }): SkillSource {
  ensureLoaded()
  const { owner, name } = parseRepo(repo) // validates
  const normalizedRepo = `${owner}/${name}`
  const existing = listSources().find((s) => s.repo === normalizedRepo && (s.path ?? '') === (opts?.path ?? ''))
  if (existing) return existing
  const source: SkillSource = {
    id: randomUUID(),
    repo: normalizedRepo,
    ...(opts?.ref ? { ref: opts.ref } : {}),
    ...(opts?.path ? { path: opts.path } : {}),
  }
  store.update((cur) => ({ ...cur, sources: [...cur.sources, source] }))
  return source
}

export function removeSource(id: string): void {
  ensureLoaded()
  store.update((cur) => ({ ...cur, sources: cur.sources.filter((s) => s.id !== id) }))
}
