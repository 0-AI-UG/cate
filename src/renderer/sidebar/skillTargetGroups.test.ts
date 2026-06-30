import { describe, it, expect } from 'vitest'
import { toSkillTargetGroups } from './skillTargetGroups'
import type { InstalledSkill } from '../../shared/skills'

const row = (skillId: string, name: string, targetId: InstalledSkill['targetId']): InstalledSkill => ({
  skillId,
  name,
  targetId,
  path: `.cate/${targetId}/${name}/SKILL.md`,
  origin: 'local',
})

describe('toSkillTargetGroups', () => {
  it('returns an empty array for no rows', () => {
    expect(toSkillTargetGroups([])).toEqual([])
  })

  it('groups skills under the agent they are installed for', () => {
    const groups = toSkillTargetGroups([
      row('a/x', 'x', 'claude-code'),
      row('a/y', 'y', 'claude-code'),
      row('a/x', 'x', 'cate-agent'),
    ])
    expect(groups).toEqual([
      { targetId: 'claude-code', skills: [{ skillId: 'a/x', name: 'x' }, { skillId: 'a/y', name: 'y' }] },
      { targetId: 'cate-agent', skills: [{ skillId: 'a/x', name: 'x' }] },
    ])
  })

  it('orders groups by the canonical target order, not first-seen', () => {
    const groups = toSkillTargetGroups([
      row('a/x', 'x', 'codex'),
      row('a/y', 'y', 'claude-code'),
    ])
    expect(groups.map((g) => g.targetId)).toEqual(['claude-code', 'codex'])
  })

  it('dedupes a skill repeated for the same agent and sorts skills by name', () => {
    const groups = toSkillTargetGroups([
      row('a/zeta', 'zeta', 'claude-code'),
      row('a/alpha', 'alpha', 'claude-code'),
      row('a/alpha', 'alpha', 'claude-code'),
    ])
    expect(groups[0].skills.map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })
})
