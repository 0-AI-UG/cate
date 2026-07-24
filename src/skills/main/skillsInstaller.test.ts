import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillEntry } from '../../shared/skills'

const resolve = vi.hoisted(() => vi.fn())
const store = vi.hoisted(() => ({
  read: vi.fn(),
  has: vi.fn(),
  cache: vi.fn(),
  remove: vi.fn(),
}))
const saved = vi.hoisted(() => ({ addSaved: vi.fn(), removeSaved: vi.fn(), isSaved: vi.fn() }))
const fetchSkillFiles = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve } }))
vi.mock('./skillStore', () => store)
vi.mock('./savedSkills', () => saved)
vi.mock('./skillSources', () => ({ getToken: () => 'token' }))
vi.mock('./githubCrawl', () => ({ fetchSkillFiles }))

import { install, saveSkill, uninstall, writeSkillToWorkspace } from './skillsInstaller'

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
  saved.isSaved.mockReset().mockReturnValue(false)
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

  // Regression: a workspace written by an older Cate can carry rows for a
  // target since dropped (`antigravity`). install() reuses "the same skill
  // installed for another agent here" as its file source, and resolving that
  // row's target used to THROW `Unknown skill target: antigravity` — so one
  // stale row blocked installing that skill for ANY agent. Stale rows are now
  // filtered on read, and the pruned list is what the next write persists.
  it('ignores manifest rows for targets this version dropped', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [
        { skillId: entry().id, name: entry().name, targetId: 'antigravity', path: '/ws/.agent/skills/demo/SKILL.md', origin: 'local' },
        { skillId: entry().id, name: entry().name, targetId: 'claude-code', path: '/claude', origin: 'local' },
      ],
      seeded: ['cate/cate-cli:antigravity@abc'],
    }))
    store.read.mockResolvedValue([{ relPath: 'SKILL.md', text: 'cached' }])

    // Installing for a live target must succeed, not throw.
    await install(entry(), 'grok', WS)

    expect(files.get(`${WS}/.grok/skills/demo-skill/SKILL.md`)).toContain('name: demo-skill')
    // The stale row is gone from the persisted manifest; live rows are kept.
    expect(manifest().skills.map((s) => s.targetId)).toEqual(['claude-code', 'grok'])
    // Its files on disk are NOT touched — only the tracking row is dropped.
    expect(removed).toEqual([])
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
  it('falls back to saved bytes when the latest source is unavailable', async () => {
    store.read.mockResolvedValue([{ relPath: 'SKILL.md', text: 'cached' }])

    const result = await install(entry(), 'codex', WS)

    expect(store.read).toHaveBeenCalledWith(entry().id)
    expect(fetchSkillFiles).toHaveBeenCalledWith(entry().source, 'token')
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('cached')
    expect(result.warnings).toContain('Latest source unavailable; installed the existing offline copy.')
  })

  it('prefers fresh source bytes over a stale saved cache', async () => {
    store.read.mockResolvedValue([{ relPath: 'SKILL.md', text: 'stale cached' }])
    fetchSkillFiles.mockResolvedValue([{ relPath: 'SKILL.md', text: 'remote' }])

    await install(entry(), 'codex', WS)

    expect(fetchSkillFiles).toHaveBeenCalledWith(entry().source, 'token')
    expect(store.read).not.toHaveBeenCalled()
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('remote')
  })

  it('prefers fresh source bytes over another agent install', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [{ skillId: entry().id, name: entry().name, targetId: 'claude-code', path: '/claude', origin: 'local' }],
    }))
    files.set(`${WS}/.claude/skills/demo-skill/SKILL.md`, 'stale agent copy')
    fetchSkillFiles.mockResolvedValue([{ relPath: 'SKILL.md', text: 'fresh source' }])

    await install(entry(), 'codex', WS)

    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('fresh source')
  })

  it('refreshes a saved cache after a successful source fetch', async () => {
    const fresh = [{ relPath: 'SKILL.md', text: 'fresh source' }]
    saved.isSaved.mockReturnValue(true)
    fetchSkillFiles.mockResolvedValue(fresh)

    await install(entry(), 'codex', WS)

    expect(store.cache).toHaveBeenCalledWith(entry().id, fresh)
  })
})

describe('saveSkill freshness', () => {
  it('replaces an existing cache with current source bytes', async () => {
    const fresh = [{ relPath: 'SKILL.md', text: 'fresh source' }]
    store.has.mockResolvedValue(true)
    fetchSkillFiles.mockResolvedValue(fresh)

    await saveSkill(entry())

    expect(fetchSkillFiles).toHaveBeenCalledWith(entry().source, 'token')
    expect(store.cache).toHaveBeenCalledWith(entry().id, fresh)
    expect(saved.addSaved).toHaveBeenCalled()
  })

  it('keeps a usable cached copy when saving offline', async () => {
    store.has.mockResolvedValue(true)
    fetchSkillFiles.mockRejectedValue(new Error('offline'))

    await expect(saveSkill(entry())).resolves.toBeUndefined()

    expect(store.cache).not.toHaveBeenCalled()
    expect(saved.addSaved).toHaveBeenCalled()
  })
})
