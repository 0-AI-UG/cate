import { describe, it, expect } from 'vitest'
import { parseFrontmatter, ensureSkillName } from './frontmatter'

describe('parseFrontmatter', () => {
  it('extracts name, description and tags', () => {
    const text = `---\nname: pdf-tools\ndescription: Fill and merge PDFs\ntags: pdf, documents\n---\n\nBody`
    const { fm, tags } = parseFrontmatter(text)
    expect(fm.name).toBe('pdf-tools')
    expect(fm.description).toBe('Fill and merge PDFs')
    expect(tags).toEqual(['pdf', 'documents'])
  })

  it('strips wrapping quotes from values', () => {
    const { fm } = parseFrontmatter(`---\nname: "quoted"\n---\n`)
    expect(fm.name).toBe('quoted')
  })

  it('returns empty maps when there is no frontmatter', () => {
    const { fm, tags } = parseFrontmatter('just a body, no frontmatter')
    expect(fm).toEqual({})
    expect(tags).toEqual([])
  })
})

describe('ensureSkillName', () => {
  it('replaces an existing name', () => {
    const out = ensureSkillName(`---\nname: old\ndescription: d\n---\nbody`, 'new')
    expect(out).toContain('name: new')
    expect(out).not.toContain('name: old')
    expect(out).toContain('description: d')
    expect(out).toContain('body')
  })

  it('adds a name when the frontmatter has none', () => {
    const out = ensureSkillName(`---\ndescription: d\n---\nbody`, 'added')
    expect(out).toContain('name: added')
    expect(out).toContain('description: d')
  })

  it('prepends a frontmatter block when the file has none', () => {
    const out = ensureSkillName('just a body', 'fresh')
    expect(out.startsWith('---\nname: fresh\n---')).toBe(true)
    expect(out).toContain('just a body')
  })
})
