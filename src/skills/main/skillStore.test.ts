import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-skill-store-'))

vi.mock('electron', () => ({ app: { getPath: () => userData } }))

import { cache, has, read, remove } from './skillStore'

beforeEach(() => {
  fs.rmSync(path.join(userData, 'skills-store'), { recursive: true, force: true })
  fs.rmSync(path.join(userData, 'outside.md'), { force: true })
})

afterAll(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('skillStore', () => {
  it('round-trips nested text and binary files under a sanitized skill key', async () => {
    const binary = Buffer.from([0xff, 0x00, 0xfe])
    await cache('owner/repo:demo', [
      { relPath: 'SKILL.md', text: 'skill body' },
      { relPath: 'references/guide.md', text: 'guide' },
      { relPath: 'assets/icon.bin', base64: binary.toString('base64') },
    ])

    expect(await has('owner/repo:demo')).toBe(true)
    expect(await read('owner/repo:demo')).toEqual(expect.arrayContaining([
      { relPath: 'SKILL.md', text: 'skill body' },
      { relPath: 'references/guide.md', text: 'guide' },
      { relPath: 'assets/icon.bin', base64: binary.toString('base64') },
    ]))
    expect(fs.readdirSync(path.join(userData, 'skills-store')).filter(name => name !== '.cate')).toHaveLength(1)
  })

  it('re-caching replaces stale files and remove drops the entry', async () => {
    await cache('demo', [
      { relPath: 'SKILL.md', text: 'old' },
      { relPath: 'stale.md', text: 'stale' },
    ])
    await cache('demo', [{ relPath: 'SKILL.md', text: 'new' }])

    expect(await read('demo')).toEqual([{ relPath: 'SKILL.md', text: 'new' }])
    expect(fs.existsSync(path.join(userData, 'skills-store', 'demo', 'stale.md'))).toBe(false)

    await remove('demo')
    expect(await has('demo')).toBe(false)
    expect(await read('demo')).toBeNull()
  })

  it('rejects traversal before deleting an existing good cache entry', async () => {
    await cache('demo', [{ relPath: 'SKILL.md', text: 'known-good' }])

    await expect(cache('demo', [
      { relPath: 'SKILL.md', text: 'replacement' },
      { relPath: '../../outside.md', text: 'escaped' },
    ])).rejects.toThrow('Unsafe skill file path')

    expect(await read('demo')).toEqual([{ relPath: 'SKILL.md', text: 'known-good' }])
    expect(fs.existsSync(path.join(userData, 'outside.md'))).toBe(false)
  })
})

it('keeps distinct IDs independent when legacy sanitization collides', async () => {
  await cache('owner/repo:demo', [{ relPath: 'SKILL.md', text: 'first' }])
  await cache('owner_repo/demo', [{ relPath: 'SKILL.md', text: 'second' }])
  expect(await read('owner/repo:demo')).toEqual([{ relPath: 'SKILL.md', text: 'first' }])
  await remove('owner_repo/demo')
  expect(await has('owner/repo:demo')).toBe(true)
})

it('migrates an unambiguous saved legacy cache without losing offline bytes', async () => {
  const { addSaved } = await import('./savedSkills')
  addSaved({ skillId: 'legacy/repo', name: 'Legacy', description: '', source: { repo: 'legacy/repo', ref: 'main', path: '' } })
  const legacy = path.join(userData, 'skills-store', 'legacy_repo')
  fs.mkdirSync(legacy, { recursive: true })
  fs.writeFileSync(path.join(legacy, 'SKILL.md'), 'offline')
  expect(await read('legacy/repo')).toEqual([{ relPath: 'SKILL.md', text: 'offline' }])
  expect(fs.existsSync(legacy)).toBe(false)
})
