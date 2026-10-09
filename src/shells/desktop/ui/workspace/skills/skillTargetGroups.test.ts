import { describe, it, expect } from 'vitest'
import { toSkillTargetGroups } from './skillTargetGroups'
import type { InstalledSkill } from '@workspace/skills/contract'

const TARGETS = [{ id: 'claude-code' }, { id: 'codex' }]

const row = (skillId: string, name: string, targetId: string): InstalledSkill => ({
  skillId,
  name,
  targetId,
  path: `/w/.${targetId}/${name}/SKILL.md`,
  origin: 'local',
})

describe('toSkillTargetGroups', () => {
  it('returns an empty array for no rows', () => {
    expect(toSkillTargetGroups([], TARGETS)).toEqual([])
  })

  it('groups skills under the agent they are installed for', () => {
    const groups = toSkillTargetGroups([
      row('a/x', 'x', 'claude-code'),
      row('a/y', 'y', 'claude-code'),
      row('a/x', 'x', 'codex'),
    ], TARGETS)
    expect(groups).toEqual([
      { targetId: 'claude-code', skills: [{ skillId: 'a/x', name: 'x' }, { skillId: 'a/y', name: 'y' }] },
      { targetId: 'codex', skills: [{ skillId: 'a/x', name: 'x' }] },
    ])
  })

  it('orders groups by the target order, not first-seen', () => {
    const groups = toSkillTargetGroups([row('a/x', 'x', 'codex'), row('a/y', 'y', 'claude-code')], TARGETS)
    expect(groups.map((g) => g.targetId)).toEqual(['claude-code', 'codex'])
  })

  it('puts unknown targets last', () => {
    const groups = toSkillTargetGroups([row('a/x', 'x', 'other'), row('a/y', 'y', 'codex')], TARGETS)
    expect(groups.map((g) => g.targetId)).toEqual(['codex', 'other'])
  })

  it('dedupes a skill repeated for the same agent and sorts skills by name', () => {
    const groups = toSkillTargetGroups([
      row('a/zeta', 'zeta', 'claude-code'),
      row('a/alpha', 'alpha', 'claude-code'),
      row('a/alpha', 'alpha', 'claude-code'),
    ], TARGETS)
    expect(groups[0].skills.map((s) => s.name)).toEqual(['alpha', 'zeta'])
  })
})
