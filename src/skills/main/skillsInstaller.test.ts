import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillEntry } from '../../shared/skills'

const resolve = vi.hoisted(() => vi.fn())
const store = vi.hoisted(() => ({
  read: vi.fn(),
  has: vi.fn(),
  cache: vi.fn(),
  remove: vi.fn(),
}))
const saved = vi.hoisted(() => ({ addSaved: vi.fn(), removeSaved: vi.fn() }))
const fetchSkillFiles = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve } }))
vi.mock('./skillStore', () => store)
vi.mock('./savedSkills', () => saved)
vi.mock('./skillSources', () => ({ getToken: () => 'token' }))
vi.mock('./githubCrawl', () => ({ fetchSkillFiles }))

import { install, uninstall, writeSkillToWorkspace } from './skillsInstaller'

const WS = '/workspace'
const MANIFEST = `${WS}/.cate/skills.json`
const norm = (value: string): string => value.replace(/\\/g, '/')

let files: Map<string, string>
let dirs: Set<string>
let removeError: Error | null
let removed: string[]

function makeRuntime() {
  return {
    file: {
      readFile: async (file: string) => {
        const value = files.get(norm(file))
        if (value == null) throw new Error(`ENOENT: ${file}`)
        return value
      },
      writeFile: async (file: string, content: string) => {
        files.set(norm(file), content)
        return file
      },
      writeBinary: async (file: string, content: Buffer) => {
        files.set(norm(file), content.toString('base64'))
        return file
      },
      mkdir: async (dir: string) => { dirs.add(norm(dir)) },
      remove: async (target: string) => {
        removed.push(norm(target))
        if (removeError) throw removeError
        files.delete(norm(target))
      },
    },
  }
}

function entry(): SkillEntry {
  return {
    id: 'owner/repo/demo',
    name: 'Demo Skill',
    description: 'demo',
    tags: [],
    format: 'skill-md',
    source: { repo: 'owner/repo', ref: 'main', path: 'skills/demo' },
    provenance: 'curated',
    sourceId: 'owner/repo',
  }
}

function manifest(): { skills: Array<{ skillId: string; targetId: string; path: string }>; seeded?: string[] } {
  return JSON.parse(files.get(MANIFEST) ?? '{"skills":[]}')
}

beforeEach(() => {
  files = new Map()
  dirs = new Set([WS])
  removed = []
  removeError = null
  resolve.mockReset().mockReturnValue(makeRuntime())
  store.read.mockReset().mockResolvedValue(null)
  store.has.mockReset().mockResolvedValue(false)
  store.cache.mockReset().mockResolvedValue(undefined)
  store.remove.mockReset().mockResolvedValue(undefined)
  saved.addSaved.mockReset()
  saved.removeSaved.mockReset()
  fetchSkillFiles.mockReset().mockResolvedValue([])
})

describe('skillsInstaller workspace manifest', () => {
  it('replaces only the matching target entry and preserves seed markers', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [
        { skillId: entry().id, name: 'old', targetId: 'codex', path: '/old', origin: 'local' },
        { skillId: entry().id, name: 'Demo Skill', targetId: 'claude-code', path: '/claude', origin: 'local' },
      ],
      seeded: ['cate/cate-cli:cate-agent'],
    }))

    await writeSkillToWorkspace({
      skillId: entry().id,
      name: entry().name,
      targetId: 'codex',
      cwd: WS,
      origin: 'local',
      files: [
        { relPath: 'SKILL.md', text: '---\nname: wrong\n---\nbody' },
        { relPath: 'references/guide.md', text: 'guide' },
      ],
    })

    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('name: demo-skill')
    expect(files.get(`${WS}/.codex/skills/demo-skill/references/guide.md`)).toBe('guide')
    const skills = manifest().skills.map((skill) => ({ ...skill, path: norm(skill.path) }))
    expect(skills).toEqual([
      expect.objectContaining({ targetId: 'claude-code', path: '/claude' }),
      expect.objectContaining({ skillId: entry().id, targetId: 'codex', path: `${WS}/.codex/skills/demo-skill/SKILL.md` }),
    ])
    expect(manifest().seeded).toEqual(['cate/cate-cli:cate-agent'])
  })

  it('removes the manifest entry even when deleting the installed files fails', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [
        { skillId: entry().id, name: entry().name, targetId: 'codex', path: '/codex', origin: 'local' },
        { skillId: entry().id, name: entry().name, targetId: 'claude-code', path: '/claude', origin: 'local' },
      ],
      seeded: ['keep-me'],
    }))
    removeError = new Error('locked')

    await uninstall(entry().id, entry().name, 'codex', WS)

    expect(removed).toEqual([`${WS}/.codex/skills/demo-skill`])
    expect(manifest().skills).toEqual([expect.objectContaining({ targetId: 'claude-code' })])
    expect(manifest().seeded).toEqual(['keep-me'])
  })

  it('rejects traversal paths before changing the workspace or manifest', async () => {
    files.set(MANIFEST, JSON.stringify({ skills: [], seeded: ['keep-me'] }))
    const beforeDirs = new Set(dirs)

    await expect(writeSkillToWorkspace({
      skillId: entry().id,
      name: entry().name,
      targetId: 'codex',
      cwd: WS,
      origin: 'local',
      files: [
        { relPath: 'SKILL.md', text: 'body' },
        { relPath: '../../outside.md', text: 'escaped' },
      ],
    })).rejects.toThrow('Unsafe skill file path')

    expect(dirs).toEqual(beforeDirs)
    expect(files.get(MANIFEST)).toBe(JSON.stringify({ skills: [], seeded: ['keep-me'] }))
    expect(files.has(`${WS}/.codex/outside.md`)).toBe(false)
  })
})

describe('skillsInstaller resolution cache', () => {
  it('uses saved bytes without fetching from GitHub', async () => {
    store.read.mockResolvedValue([{ relPath: 'SKILL.md', text: 'cached' }])

    await install(entry(), 'codex', WS)

    expect(store.read).toHaveBeenCalledWith(entry().id)
    expect(fetchSkillFiles).not.toHaveBeenCalled()
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('cached')
  })

  it('fetches only when the saved cache is empty', async () => {
    fetchSkillFiles.mockResolvedValue([{ relPath: 'SKILL.md', text: 'remote' }])

    await install(entry(), 'codex', WS)

    expect(fetchSkillFiles).toHaveBeenCalledWith(entry().source, 'token')
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('remote')
  })
})
