import { describe, it, expect } from 'vitest'
import { toSkillChips } from './skillChips'
import type { InstalledSkill } from '../../shared/skills'

const row = (skillId: string, name: string, targetId: InstalledSkill['targetId']): InstalledSkill => ({
  skillId,
  name,
  targetId,
  path: `.cate/${targetId}/${name}/SKILL.md`,
  origin: 'local',
})

describe('toSkillChips', () => {
  it('returns an empty array for no rows', () => {
    expect(toSkillChips([])).toEqual([])
  })

  it('folds the same skill installed for several agents into one chip', () => {
    const chips = toSkillChips([
      row('a/grill-me', 'grill-me', 'claude-code'),
      row('a/grill-me', 'grill-me', 'cate-agent'),
    ])
    expect(chips).toHaveLength(1)
    expect(chips[0]).toEqual({
      skillId: 'a/grill-me',
      name: 'grill-me',
      targets: ['claude-code', 'cate-agent'],
    })
  })

  it('dedupes a repeated target for the same skill', () => {
    const chips = toSkillChips([
      row('a/x', 'x', 'claude-code'),
      row('a/x', 'x', 'claude-code'),
    ])
    expect(chips[0].targets).toEqual(['claude-code'])
  })

  it('sorts chips by name', () => {
    const chips = toSkillChips([
      row('a/zeta', 'zeta', 'claude-code'),
      row('a/alpha', 'alpha', 'claude-code'),
      row('a/mid', 'mid', 'claude-code'),
    ])
    expect(chips.map((c) => c.name)).toEqual(['alpha', 'mid', 'zeta'])
  })

  it('keeps distinct skills separate', () => {
    const chips = toSkillChips([
      row('a/one', 'one', 'claude-code'),
      row('a/two', 'two', 'cate-agent'),
    ])
    expect(chips.map((c) => c.skillId)).toEqual(['a/one', 'a/two'])
  })
})
