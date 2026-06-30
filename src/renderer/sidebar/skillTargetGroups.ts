// Pure helper for WorkspaceSkillsTree — kept React-free so it can be unit-tested
// in the node test environment (a `.test.ts` whose import graph reaches React /
// phosphor / the logger would break or hang the node worker).

import { SKILL_TARGETS, type InstalledSkill, type SkillTargetId } from '../../shared/skills'

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

// The workspace manifest lists one row per (skill × target). Group those by
// target/agent, each with its skills (deduped, name-sorted). Groups are ordered
// by the canonical SKILL_TARGETS order so the tree reads Claude Code first,
// etc. — for rendering one agent row with its skills nested beneath.
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
