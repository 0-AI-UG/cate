import { describe, it, expect } from 'vitest'
import { parseRepo } from './githubCrawl'
import { slugifySkillName, getSkillTarget } from '../../shared/skills'

describe('parseRepo', () => {
  it('parses owner/name', () => {
    expect(parseRepo('anthropics/skills')).toEqual({ owner: 'anthropics', name: 'skills' })
  })

  it('parses a full GitHub URL and strips .git / trailing slash', () => {
    expect(parseRepo('https://github.com/foo/bar.git')).toEqual({ owner: 'foo', name: 'bar' })
    expect(parseRepo('github.com/foo/bar/')).toEqual({ owner: 'foo', name: 'bar' })
  })

  it('throws on an invalid repo', () => {
    expect(() => parseRepo('not-a-repo')).toThrow()
  })
})

describe('slugifySkillName', () => {
  it('produces an OpenCode-safe slug (^[a-z0-9]+(-[a-z0-9]+)*$)', () => {
    const re = /^[a-z0-9]+(-[a-z0-9]+)*$/
    expect(re.test(slugifySkillName('PDF Tools!'))).toBe(true)
    expect(slugifySkillName('PDF Tools!')).toBe('pdf-tools')
    expect(slugifySkillName('  Weird __ Name -- ')).toBe('weird-name')
  })

  it('falls back to "skill" for empty input', () => {
    expect(slugifySkillName('   ')).toBe('skill')
  })
})

describe('getSkillTarget', () => {
  it('returns target info and flags antigravity as beta', () => {
    expect(getSkillTarget('claude-code').label).toBe('Claude Code')
    expect(getSkillTarget('antigravity').beta).toBe(true)
  })
})
