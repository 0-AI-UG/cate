import { describe, expect, it } from 'vitest'
import { ensureSkillName, parseFrontmatter, parseRepo, skillPathSegments, slugifySkillName } from '../contract'

describe('parseFrontmatter', () => {
  it('extracts name, description and tags', () => {
    const { fm, tags } = parseFrontmatter(`---\nname: pdf-tools\ndescription: Fill and merge PDFs\ntags: pdf, documents\n---\n\nBody`)
    expect(fm.name).toBe('pdf-tools')
    expect(fm.description).toBe('Fill and merge PDFs')
    expect(tags).toEqual(['pdf', 'documents'])
  })

  it('strips wrapping quotes from values', () => {
    expect(parseFrontmatter(`---\nname: "quoted"\n---\n`).fm.name).toBe('quoted')
  })

  it('returns empty maps when there is no frontmatter', () => {
    expect(parseFrontmatter('just a body')).toEqual({ fm: {}, tags: [] })
  })

  it.each([
    ['>', 'First line second line'],
    ['|', 'First line\nsecond line'],
  ])('parses %s block descriptions', (style, expected) => {
    expect(parseFrontmatter(`---\nname: demo\ndescription: ${style}\n  First line\n  second line\n---\n`).fm.description).toBe(expected)
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

describe('parseRepo', () => {
  it('parses owner/name and GitHub URLs', () => {
    expect(parseRepo('anthropics/skills')).toEqual({ owner: 'anthropics', name: 'skills' })
    expect(parseRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', name: 'bar' })
    expect(parseRepo('github.com/foo/bar/')).toEqual({ owner: 'foo', name: 'bar' })
  })

  it('throws on an invalid repo', () => {
    expect(() => parseRepo('not-a-repo')).toThrow()
  })
})

describe('slugifySkillName', () => {
  it('produces an OpenCode-safe slug', () => {
    expect(slugifySkillName('PDF Tools!')).toBe('pdf-tools')
    expect(slugifySkillName('  Weird __ Name -- ')).toBe('weird-name')
    expect(slugifySkillName('   ')).toBe('skill')
  })
})

describe('skillPathSegments', () => {
  it('rejects paths that escape the bundle', () => {
    expect(skillPathSegments('references/guide.md')).toEqual(['references', 'guide.md'])
    for (const bad of ['../x', '/abs', 'a//b', './a', 'C:\\x']) expect(() => skillPathSegments(bad)).toThrow('Unsafe')
  })
})
