import { describe, it, expect } from 'vitest'
import { curateSkills } from './build-skills-index.mjs'

// The registry curation applies two independent quality floors:
//   - description floor: applies to EVERYONE (a descriptionless skill renders as
//     a broken empty row in SkillsDialog, no matter who authored it).
//   - star floor: waived for first-party skills (Cate's own ship regardless of
//     adoption), enforced for everyone else.
describe('curateSkills', () => {
  const firstPartyIds = new Set(['cate'])

  const entry = (over) => ({
    id: 'cate/example',
    name: 'Example',
    description: 'A described skill.',
    tags: [],
    format: 'skill-md',
    source: { repo: '0-AI-UG/cate', ref: 'main', path: 'skills/example' },
    provenance: 'curated',
    sourceId: 'cate',
    ...over,
  })

  it('drops a first-party skill with no description (description floor is not waived)', () => {
    const entries = [
      entry({ id: 'cate/described', description: 'Has a description.' }),
      entry({ id: 'cate/blank', description: '' }),
      entry({ id: 'cate/whitespace', description: '   ' }),
    ]
    const curated = curateSkills(entries, firstPartyIds)
    const ids = curated.map((s) => s.id)
    expect(ids).toContain('cate/described')
    expect(ids).not.toContain('cate/blank')
    expect(ids).not.toContain('cate/whitespace')
  })

  it('keeps a described first-party skill below the star floor (star floor is waived)', () => {
    const entries = [
      entry({ id: 'cate/low-stars', description: 'Described.', stars: 3 }),
    ]
    const curated = curateSkills(entries, firstPartyIds)
    expect(curated.map((s) => s.id)).toContain('cate/low-stars')
    expect(curated[0].firstParty).toBe(true)
  })

  it('enforces both floors for third-party skills', () => {
    const entries = [
      entry({ id: 'other/no-desc', sourceId: 'other', description: '', stars: 50_000 }),
      entry({ id: 'other/low-stars', sourceId: 'other', description: 'Described.', stars: 5 }),
      entry({ id: 'other/good', sourceId: 'other', description: 'Described.', stars: 50_000 }),
    ]
    const ids = curateSkills(entries, firstPartyIds).map((s) => s.id)
    expect(ids).toEqual(['other/good'])
  })
})
