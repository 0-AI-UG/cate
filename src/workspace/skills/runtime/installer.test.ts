import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDirLocks, nodeSkillFiles, type SkillFiles } from './files'
import { createSkillInstaller } from './installer'
import { createTargetTable } from './targets'
import { memorySkillFiles, TEST_TARGETS } from './testSupport'

const targets = createTargetTable(TEST_TARGETS)
const norm = (value: string): string => value.replace(/\\/g, '/')

describe('installer on an in-memory workspace', () => {
  const WS = '/workspace'
  const MANIFEST = `${WS}/.cate/skills.json`
  let files: Map<string, string>
  let dirs: Set<string>
  let host: SkillFiles
  let installer: ReturnType<typeof createSkillInstaller>
  const manifest = () => JSON.parse(files.get(MANIFEST) ?? '{"skills":[]}') as { skills: Array<{ skillId: string; targetId: string; path: string }>; seeded?: string[] }
  const write = (targetId: string, skillFiles: Array<{ relPath: string; text: string }>) =>
    installer.writeSkill({ skillId: 'owner/repo/demo', name: 'Demo Skill', targetId, cwd: WS, files: skillFiles })

  beforeEach(() => {
    files = new Map()
    dirs = new Set([WS])
    host = memorySkillFiles(files, dirs)
    installer = createSkillInstaller({ files: host, targets, withDirs: createDirLocks() })
  })

  it('materializes and removes the target root', async () => {
    await write('codex', [{ relPath: 'SKILL.md', text: 'body' }])
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('body')
    expect(manifest().skills).toHaveLength(1)
    expect(norm(manifest().skills[0].path)).toBe(`${WS}/.codex/skills/demo-skill/SKILL.md`)

    await installer.uninstall('owner/repo/demo', 'codex', WS)
    expect(files.has(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toBe(false)
    expect(manifest().skills).toEqual([])
  })

  it('replaces only the matching target entry and preserves seed markers', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [
        { skillId: 'owner/repo/demo', name: 'old', targetId: 'codex', path: '/old', origin: 'local' },
        { skillId: 'owner/repo/demo', name: 'Demo Skill', targetId: 'claude-code', path: '/claude', origin: 'local' },
      ],
      seeded: ['cate/cate-cli:codex'],
    }))
    await write('codex', [
      { relPath: 'SKILL.md', text: '---\nname: wrong\n---\nbody' },
      { relPath: 'references/guide.md', text: 'guide' },
    ])
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('name: demo-skill')
    expect(files.get(`${WS}/.codex/skills/demo-skill/references/guide.md`)).toBe('guide')
    expect(manifest().skills.map((s) => ({ ...s, path: norm(s.path) }))).toEqual([
      expect.objectContaining({ targetId: 'claude-code', path: '/claude' }),
      expect.objectContaining({ targetId: 'codex', path: `${WS}/.codex/skills/demo-skill/SKILL.md` }),
    ])
    expect(manifest().seeded).toEqual(['cate/cate-cli:codex'])
  })

  it('retains ownership when a destination cannot be retired', async () => {
    await write('codex', [{ relPath: 'SKILL.md', text: 'owned' }])
    const rename = host.rename
    host.rename = async (from, to) => {
      if (norm(from).endsWith('/skills/demo-skill')) throw new Error('locked')
      return rename(from, to)
    }
    await expect(installer.uninstall('owner/repo/demo', 'codex', WS)).rejects.toThrow('locked')
    expect(manifest().skills).toHaveLength(1)
    expect(files.get(`${WS}/.codex/skills/demo-skill/SKILL.md`)).toContain('owned')
  })

  it('drops manifest rows for targets this version does not have', async () => {
    files.set(MANIFEST, JSON.stringify({
      skills: [
        { skillId: 'owner/repo/demo', name: 'Demo Skill', targetId: 'antigravity', path: '/x', origin: 'local' },
        { skillId: 'owner/repo/demo', name: 'Demo Skill', targetId: 'claude-code', path: '/claude', origin: 'local' },
      ],
    }))
    await write('grok', [{ relPath: 'SKILL.md', text: 'body' }])
    expect(manifest().skills.map((s) => s.targetId)).toEqual(['claude-code', 'grok'])
  })

  it('rejects traversal paths before changing the workspace or manifest', async () => {
    files.set(MANIFEST, JSON.stringify({ skills: [], seeded: ['keep-me'] }))
    const beforeDirs = new Set(dirs)
    await expect(write('codex', [
      { relPath: 'SKILL.md', text: 'body' },
      { relPath: '../../outside.md', text: 'escaped' },
    ])).rejects.toThrow('Unsafe skill file path')
    expect(dirs).toEqual(beforeDirs)
    expect(files.get(MANIFEST)).toBe(JSON.stringify({ skills: [], seeded: ['keep-me'] }))
  })
})

describe('installer on disk', () => {
  let cwd: string
  let host: SkillFiles
  let installer: ReturnType<typeof createSkillInstaller>
  const bundle = (name: string, skillFiles: Array<{ relPath: string; text?: string; base64?: string }> = [{ relPath: 'SKILL.md', text: 'body' }]) => ({
    skillId: name, name, targetId: 'codex', cwd, files: skillFiles,
  })

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-skill-lifecycle-'))
    host = { ...nodeSkillFiles }
    installer = createSkillInstaller({ files: host, targets, withDirs: createDirLocks() })
  })
  afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }) })

  it('serializes installations and seeding against one manifest', async () => {
    await Promise.all([
      installer.writeSkill(bundle('first')),
      installer.writeSkill(bundle('second')),
      installer.setSeededMarker(cwd, 'bundled:codex@hash'),
    ])
    const manifest = JSON.parse(await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8'))
    expect(manifest.skills.map((s: { skillId: string }) => s.skillId).sort()).toEqual(['first', 'second'])
    expect(manifest.seeded).toEqual(['bundled:codex@hash'])
  })

  it('removes retired managed resources while preserving user-added and user-edited files', async () => {
    await installer.writeSkill(bundle('demo', [
      { relPath: 'SKILL.md', text: 'v1' },
      { relPath: 'old.py', text: 'managed' },
      { relPath: 'edited.py', text: 'original' },
    ]))
    const dir = path.join(cwd, '.codex/skills/demo')
    await fs.writeFile(path.join(dir, 'user.md'), 'my notes')
    await fs.writeFile(path.join(dir, 'edited.py'), 'my edit')
    await installer.writeSkill(bundle('demo', [{ relPath: 'SKILL.md', text: 'v2' }]))
    expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['SKILL.md', 'user.md', 'edited.py']))
    await expect(fs.stat(path.join(dir, 'old.py'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(path.join(dir, 'edited.py'), 'utf8')).toBe('my edit')
  })

  it('rolls a failed replacement back without publishing a new manifest', async () => {
    await installer.writeSkill(bundle('rollback', [{ relPath: 'SKILL.md', text: 'known good' }]))
    const manifestBefore = await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8')
    host.rename = async (from, to) => {
      if (from.includes('.skills-mirror-stage-') && norm(to).endsWith('/rollback')) throw new Error('injected publication failure')
      return nodeSkillFiles.rename(from, to)
    }
    await expect(installer.writeSkill(bundle('rollback', [{ relPath: 'SKILL.md', text: 'replacement' }]))).rejects.toThrow('injected publication failure')
    expect(await fs.readFile(path.join(cwd, '.codex/skills/rollback/SKILL.md'), 'utf8')).toContain('known good')
    expect(await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8')).toBe(manifestBefore)
  })

  it('preserves binary companion bytes when an install is read back', async () => {
    const bytes = Buffer.from([0xff, 0x00, 0x80, 0x01])
    await installer.writeSkill(bundle('binary', [{ relPath: 'SKILL.md', text: 'body' }, { relPath: 'asset.bin', base64: bytes.toString('base64') }]))
    const files = await installer.readWorkspaceSkillFiles(cwd, 'codex', 'binary')
    expect(files).toContainEqual({ relPath: 'asset.bin', base64: bytes.toString('base64') })
  })

  it('rejects a different skill claiming an installed destination', async () => {
    await installer.writeSkill({ ...bundle('review'), skillId: 'a/review' })
    await expect(installer.writeSkill({ ...bundle('review'), skillId: 'b/review', files: [{ relPath: 'SKILL.md', text: 'other' }] })).rejects.toThrow(/owned/)
    expect(await fs.readFile(path.join(cwd, '.codex/skills/review/SKILL.md'), 'utf8')).toContain('body')
  })

  it('retires the old owned destination on rename and uninstalls by recorded identity', async () => {
    await installer.writeSkill({ ...bundle('old'), skillId: 'stable' })
    await installer.writeSkill({ ...bundle('new'), skillId: 'stable' })
    await expect(fs.stat(path.join(cwd, '.codex/skills/old'))).rejects.toMatchObject({ code: 'ENOENT' })
    await installer.uninstall('stable', 'codex', cwd)
    await expect(fs.stat(path.join(cwd, '.codex/skills/new'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls bundle bytes back if manifest publication fails', async () => {
    await installer.writeSkill(bundle('owned', [{ relPath: 'SKILL.md', text: 'v1' }]))
    host.rename = async (from, to) => {
      if (norm(to).endsWith('/.cate/skills.json')) throw new Error('manifest unavailable')
      return nodeSkillFiles.rename(from, to)
    }
    await expect(installer.writeSkill(bundle('owned', [{ relPath: 'SKILL.md', text: 'v2' }]))).rejects.toThrow('manifest unavailable')
    expect(await fs.readFile(path.join(cwd, '.codex/skills/owned/SKILL.md'), 'utf8')).toContain('v1')
  })

  it('rolls all consumer roots back when the second publication fails', async () => {
    const withConsumer = createTargetTable(TEST_TARGETS.map((t) => t.id === 'codex' ? { ...t, mirrorBaseSegments: [['.consumer', 'skills']] } : t))
    const consumerInstaller = createSkillInstaller({ files: host, targets: withConsumer, withDirs: createDirLocks() })
    const roots = [path.join(cwd, '.codex/skills'), path.join(cwd, '.consumer/skills')]
    await consumerInstaller.writeSkill(bundle('owned', [{ relPath: 'SKILL.md', text: 'v1' }]))
    host.rename = async (from, to) => {
      if (from.includes('.skills-mirror-stage-') && to === path.join(roots[1], 'owned')) throw new Error('second consumer failed')
      return nodeSkillFiles.rename(from, to)
    }
    await expect(consumerInstaller.writeSkill(bundle('owned', [{ relPath: 'SKILL.md', text: 'v2' }]))).rejects.toThrow('second consumer failed')
    for (const root of roots) expect(await fs.readFile(path.join(root, 'owned/SKILL.md'), 'utf8')).toContain('v1')
  })
})
