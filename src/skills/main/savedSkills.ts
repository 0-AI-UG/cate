// =============================================================================
// Saved skills library — Cate's userData list of skills the user saved.
//
// A saved skill records its metadata here; the canonical bytes live in the skill
// store (skillStore), keyed by skillId. Saving is library-only — nothing is
// written to any workspace until the user installs the skill there.
// =============================================================================

import { createJsonStateFile } from '../../main/jsonStateFile'
import type { SavedSkill } from '../../shared/skills'

interface SavedSkillsState {
  skills: SavedSkill[]
}

const DEFAULTS: SavedSkillsState = { skills: [] }

const store = createJsonStateFile<SavedSkillsState>({
  filename: 'saved-skills.json',
  defaults: DEFAULTS,
  normalize: (parsed, defaults) => {
    if (!parsed || typeof parsed !== 'object') return defaults
    const raw = (parsed as { skills?: unknown }).skills
    if (!Array.isArray(raw)) return defaults
    const skills = raw.filter(
      (s): s is SavedSkill =>
        !!s && typeof s === 'object' &&
        typeof (s as SavedSkill).skillId === 'string' &&
        typeof (s as SavedSkill).name === 'string',
    )
    return { skills }
  },
})

let loaded = false
function ensureLoaded(): void {
  if (!loaded) {
    store.load()
    loaded = true
  }
}

export function listSaved(): SavedSkill[] {
  ensureLoaded()
  return store.get().skills
}

export function addSaved(skill: SavedSkill): void {
  ensureLoaded()
  store.update((cur) =>
    cur.skills.some((s) => s.skillId === skill.skillId)
      ? { skills: cur.skills.map((s) => (s.skillId === skill.skillId ? skill : s)) }
      : { skills: [...cur.skills, skill] },
  )
}

export function removeSaved(skillId: string): void {
  ensureLoaded()
  store.update((cur) => ({ skills: cur.skills.filter((s) => s.skillId !== skillId) }))
}

export function isSaved(skillId: string): boolean {
  return listSaved().some((s) => s.skillId === skillId)
}
