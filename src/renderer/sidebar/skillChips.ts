// Pure helper for SkillsQuickBar — kept React-free so it can be unit-tested in
// the node test environment (a `.test.ts` whose import graph reaches React /
// phosphor / the logger would break or hang the node worker).

import { SKILL_TARGETS, type InstalledSkill, type SkillTargetId } from '../../shared/skills'

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

// One skill within a target group.
export interface GroupedSkill {
  skillId: string
  name: string
}

// A target (agent) and the skills installed into the workspace for it.
export interface SkillTargetGroup {
  targetId: SkillTargetId
  skills: GroupedSkill[]
}

const TARGET_ORDER = new Map(SKILL_TARGETS.map((t, i) => [t.id, i]))

// Fold the (skill × target) manifest rows the other way from `toSkillChips`:
// group by target/agent, each with its skills (deduped, name-sorted). Groups are
// ordered by the canonical SKILL_TARGETS order so the tree reads Claude Code
// first, etc. — for rendering one agent row with its skills nested beneath.
export function toSkillTargetGroups(rows: InstalledSkill[]): SkillTargetGroup[] {
  const map = new Map<SkillTargetId, SkillTargetGroup>()
  for (const r of rows) {
    let g = map.get(r.targetId)
    if (!g) {
      g = { targetId: r.targetId, skills: [] }
      map.set(r.targetId, g)
    }
    if (!g.skills.some((s) => s.skillId === r.skillId)) {
      g.skills.push({ skillId: r.skillId, name: r.name })
    }
  }
  for (const g of map.values()) g.skills.sort((a, b) => a.name.localeCompare(b.name))
  return [...map.values()].sort(
    (a, b) => (TARGET_ORDER.get(a.targetId) ?? 99) - (TARGET_ORDER.get(b.targetId) ?? 99),
  )
}
