// Pure helper for SkillsQuickBar — kept React-free so it can be unit-tested in
// the node test environment (a `.test.ts` whose import graph reaches React /
// phosphor / the logger would break or hang the node worker).

import type { InstalledSkill, SkillTargetId } from '../../shared/skills'

// One chip per skill, regardless of how many agents (targets) it's installed for.
export interface SkillChip {
  skillId: string
  name: string
  targets: SkillTargetId[]
}

// The workspace manifest lists one row per (skill × target). Fold those into one
// chip each — keeping the set of agents (deduped, first-seen order) so the chip
// tooltip can name them — and sort the chips by name for a stable display.
export function toSkillChips(rows: InstalledSkill[]): SkillChip[] {
  const map = new Map<string, SkillChip>()
  for (const r of rows) {
    const cur = map.get(r.skillId)
    if (cur) {
      if (!cur.targets.includes(r.targetId)) cur.targets.push(r.targetId)
    } else {
      map.set(r.skillId, { skillId: r.skillId, name: r.name, targets: [r.targetId] })
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}
