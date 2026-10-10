import { describe, expect, it } from 'vitest'
import { groupSkillsByRepository, skillRows, skillSearchTerms } from './catalog'
import type { InstalledSkill, SkillEntry } from './types'

const entry = (id: string, patch: Partial<SkillEntry> = {}): SkillEntry => ({
  id,
  name: id,
  description: '',
  tags: [],
  format: 'skill-md',
  source: { repo: 'org/repo', ref: 'main', path: id },
  provenance: 'curated',
  sourceId: 'curated',
  ...patch,
})
const inst = (skillId: string): InstalledSkill => ({ skillId, name: skillId, targetId: 'claude', path: `/x/${skillId}`, origin: 'local' })

describe('skillRows', () => {
  it('shows each skill once: first-party, installed (stubbed when unknown), then the rest by stars', () => {
    const index = [entry('b', { stars: 1 }), entry('a', { stars: 5 }), entry('cate', { firstParty: true }), entry('done')]
    const rows = skillRows(index, [inst('done'), inst('local-only')], [])
    expect(rows.cate.map((e) => e.id)).toEqual(['cate'])
    expect(rows.installed.map((e) => e.id)).toEqual(['done', 'local-only'])
    expect(rows.installed[1].source.repo).toBe('')
    expect(rows.browse.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('filters every section by all search terms', () => {
    const index = [entry('pdf-tools', { description: 'Merge PDFs' }), entry('other')]
    const rows = skillRows(index, [inst('other')], skillSearchTerms('  PDF  merge '))
    expect(rows.browse.map((e) => e.id)).toEqual(['pdf-tools'])
    expect(rows.installed).toEqual([])
  })
})

it('groups skills by repository case-insensitively', () => {
  const groups = groupSkillsByRepository([entry('a', { source: { repo: 'Org/Repo', ref: 'main', path: '' } }), entry('b'), entry('c', { source: { repo: 'x/y', ref: 'main', path: '' } })])
  expect(groups.map((g) => [g.repo, g.entries.length])).toEqual([['Org/Repo', 2], ['x/y', 1]])
})
