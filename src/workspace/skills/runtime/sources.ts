// The workspace's skill sources (`<data>/skills/sources.json`): repos to crawl
// on top of the curated index.

import { randomUUID } from 'node:crypto'
import { createJsonStateFile, type JsonStateFile } from '@kernel/state/node'
import { parseRepo, type SkillSource } from '../contract'

interface SkillSourcesState {
  sources: SkillSource[]
}

export interface SkillSources {
  list(): SkillSource[]
  /** "owner/name" or a GitHub URL; throws on an invalid repo. */
  add(repo: string, opts?: { ref?: string; path?: string }): SkillSource
  remove(id: string): void
  readonly file: JsonStateFile<SkillSourcesState>
}

export function openSkillSources(file: string): SkillSources {
  const store = createJsonStateFile<SkillSourcesState>({
    file,
    defaults: { sources: [] },
    normalize: (parsed, defaults) => {
      if (!parsed || typeof parsed !== 'object') return defaults
      const raw = (parsed as Partial<SkillSourcesState>).sources
      const sources = Array.isArray(raw)
        ? raw.filter((s): s is SkillSource => !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.repo === 'string')
        : []
      return { sources }
    },
  })
  store.load()
  return {
    file: store,
    list: () => store.get().sources,
    add(repo, opts) {
      const { owner, name } = parseRepo(repo)
      const normalizedRepo = `${owner}/${name}`
      const existing = store.get().sources.find((s) => s.repo === normalizedRepo && (s.path ?? '') === (opts?.path ?? ''))
      if (existing) return existing
      const source: SkillSource = {
        id: randomUUID(),
        repo: normalizedRepo,
        ...(opts?.ref ? { ref: opts.ref } : {}),
        ...(opts?.path ? { path: opts.path } : {}),
      }
      store.update((cur) => ({ ...cur, sources: [...cur.sources, source] }))
      return source
    },
    remove(id) {
      store.update((cur) => ({ ...cur, sources: cur.sources.filter((s) => s.id !== id) }))
    },
  }
}
