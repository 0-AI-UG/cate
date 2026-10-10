// The skills view's model: installed skills merged with the catalog, filtered
// by a search and split into Cate's own, installed and the rest.

import type { InstalledSkill, SkillEntry } from './types'

/** The lowercase words of a search; every one must match. */
export function skillSearchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

function matches(entry: SkillEntry, terms: string[]): boolean {
  if (terms.length === 0) return true
  const hay = `${entry.name} ${entry.description} ${entry.source.repo}`.toLowerCase()
  return terms.every((t) => hay.includes(t))
}

function stubEntry(m: InstalledSkill): SkillEntry {
  return {
    id: m.skillId,
    name: m.name,
    description: '',
    tags: [],
    format: 'skill-md',
    source: { repo: '', ref: '', path: '' },
    provenance: 'user',
    sourceId: '',
  }
}

export interface SkillRows {
  /** Cate's first-party skills not installed yet, by name. */
  cate: SkillEntry[]
  /** Installed skills, by name. */
  installed: SkillEntry[]
  /** Every other catalog skill not installed, most stars first. */
  browse: SkillEntry[]
}

/** The rows matching `terms`, each skill shown once. */
export function skillRows(index: readonly SkillEntry[], installed: readonly InstalledSkill[], terms: string[]): SkillRows {
  // One metadata source per skill: the catalog, else a manifest stub for
  // anything installed we know nothing else about.
  const byId = new Map<string, SkillEntry>()
  for (const e of index) if (!byId.has(e.id)) byId.set(e.id, e)
  for (const inst of installed) if (!byId.has(inst.skillId)) byId.set(inst.skillId, stubEntry(inst))
  const installedIds = new Set(installed.map((m) => m.skillId))
  const available = (e: SkillEntry) => !installedIds.has(e.id) && matches(e, terms)
  return {
    cate: index
      .filter((e) => e.firstParty && available(e))
      .sort((a, b) => a.name.localeCompare(b.name)),
    installed: [...installedIds]
      .map((id) => byId.get(id))
      .filter((e): e is SkillEntry => !!e && matches(e, terms))
      .sort((a, b) => a.name.localeCompare(b.name)),
    browse: index
      .filter((e) => !e.firstParty && available(e))
      .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0) || a.name.localeCompare(b.name)),
  }
}

/** `entries` grouped by source repository (case-insensitive), in order. */
export function groupSkillsByRepository(entries: readonly SkillEntry[]): { repo: string; entries: SkillEntry[] }[] {
  const groups = new Map<string, { repo: string; entries: SkillEntry[] }>()
  for (const entry of entries) {
    const key = entry.source.repo.toLowerCase()
    const group = groups.get(key)
    if (group) group.entries.push(entry)
    else groups.set(key, { repo: entry.source.repo, entries: [entry] })
  }
  return [...groups.values()]
}
