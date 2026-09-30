// Pure helper for WorkspaceSkillsTree, kept React-free so it tests in the node
// environment.

import type { InstalledSkill, SkillTarget, SkillTargetId } from '../contract'

export interface GroupedSkill {
  skillId: string
  name: string
}

/** A target (agent) and the skills installed into the workspace for it. */
export interface SkillTargetGroup {
  targetId: SkillTargetId
  skills: GroupedSkill[]
}

/** The manifest lists one row per (skill x target). Groups them by target, each
 *  with its skills (deduped, name-sorted), in the order of `targets` so the tree
 *  reads Claude Code first. */
export function toSkillTargetGroups(rows: readonly InstalledSkill[], targets: readonly Pick<SkillTarget, 'id'>[]): SkillTargetGroup[] {
  const order = new Map(targets.map((t, i) => [t.id, i]))
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
    (a, b) => (order.get(a.targetId) ?? 99) - (order.get(b.targetId) ?? 99),
  )
}
