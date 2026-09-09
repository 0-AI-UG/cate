import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeSkillToWorkspace, setSeededMarker } from './skillsInstaller'

const h = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve: h.resolve } }))
vi.mock('./skillSources', () => ({ getToken: () => undefined }))
vi.mock('./savedSkills', () => ({ isSaved: () => false }))
let cwd: string
let requiredScope: string | undefined
const check = (access?: { scopeId?: string }) => {
  if (requiredScope && access?.scopeId !== requiredScope) throw new Error('Missing workspace scope')
}
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-skill-lifecycle-'))
  requiredScope = undefined
  h.resolve.mockReturnValue({ file: {
    readFile: async (p: string, access?: object) => {
      check(access)
      const text = await fs.readFile(p, 'utf8')
      // Model a real asynchronous host: each read returns its captured revision.
      if (p.endsWith('skills.json')) await new Promise(resolve => setTimeout(resolve, 5))
      return text
    },
    readBinary: async (p: string, access?: object) => { check(access); return fs.readFile(p) },
    writeFile: async (p: string, text: string, access?: object) => { check(access); await fs.writeFile(p, text); return p },
    writeBinary: async (p: string, data: Buffer, access?: object) => { check(access); await fs.writeFile(p, data); return p },
    mkdir: async (p: string, access?: object) => { check(access); await fs.mkdir(p, { recursive: true }) },
    remove: async (p: string, access?: object) => { check(access); await fs.rm(p, { recursive: true, force: true }) },
    rename: async (a: string, b: string, access?: object) => { check(access); await fs.rename(a, b); return b },
    stat: async (p: string, access?: object) => { check(access); const s = await fs.stat(p); return { isFile: s.isFile(), isDirectory: s.isDirectory() } },
    readDir: async (p: string, access?: object) => {
      check(access)
      return (await fs.readdir(p, { withFileTypes: true })).map(e => ({ name: e.name, isDirectory: e.isDirectory(), path: path.join(p, e.name) }))
    },
  } })
})
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }) })
const bundle = (name: string, files = [{ relPath: 'SKILL.md', text: 'body' }]) => ({
  skillId: name, name, targetId: 'codex' as const, cwd, files, origin: 'local' as const,
})

it('serializes installations and seeding against one workspace manifest', async () => {
  await fs.mkdir(path.join(cwd, '.cate'))
  await fs.writeFile(path.join(cwd, '.cate/skills.json'), '{"skills":[]}')
  await Promise.all([
    writeSkillToWorkspace(bundle('first')),
    writeSkillToWorkspace(bundle('second')),
    setSeededMarker(h.resolve(), 'local', cwd, 'bundled:codex@hash'),
  ])
  const manifest = JSON.parse(await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8'))
  expect(manifest.skills.map((s: { skillId: string }) => s.skillId).sort()).toEqual(['first', 'second'])
  expect(manifest.seeded).toEqual(['bundled:codex@hash'])
})

it('removes retired managed resources while preserving user-added and user-edited files', async () => {
  await writeSkillToWorkspace(bundle('demo', [
    { relPath: 'SKILL.md', text: 'v1' },
    { relPath: 'old.py', text: 'managed' },
    { relPath: 'edited.py', text: 'original' },
  ]))
  const dir = path.join(cwd, '.codex/skills/demo')
  await fs.writeFile(path.join(dir, 'user.md'), 'my notes')
  await fs.writeFile(path.join(dir, 'edited.py'), 'my edit')
  await writeSkillToWorkspace(bundle('demo', [{ relPath: 'SKILL.md', text: 'v2' }]))
  expect(await fs.readdir(dir)).toEqual(expect.arrayContaining(['SKILL.md', 'user.md', 'edited.py']))
  await expect(fs.stat(path.join(dir, 'old.py'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(path.join(dir, 'edited.py'), 'utf8')).toBe('my edit')
})

it('uses the workspace grant for every filesystem operation', async () => {
  requiredScope = 'outside-home-workspace'
  await expect(writeSkillToWorkspace({ ...bundle('scoped'), access: { scopeId: requiredScope, ownerWindowId: 7 } } as Parameters<typeof writeSkillToWorkspace>[0])).resolves.toMatchObject({ installed: { skillId: 'scoped' } })
})

it('rolls a failed replacement back without publishing a new manifest', async () => {
  await writeSkillToWorkspace(bundle('rollback', [{ relPath: 'SKILL.md', text: 'known good' }]))
  const manifestBefore = await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8')
  const runtime = h.resolve()
  const rename = runtime.file.rename
  runtime.file.rename = async (from: string, to: string, access?: object) => {
    if (from.includes('.skills-mirror-stage-') && to.replace(/\\/g, '/').endsWith('/rollback')) throw new Error('injected publication failure')
    return rename(from, to, access)
  }
  await expect(writeSkillToWorkspace(bundle('rollback', [{ relPath: 'SKILL.md', text: 'replacement' }]))).rejects.toThrow('injected publication failure')
  expect(await fs.readFile(path.join(cwd, '.codex/skills/rollback/SKILL.md'), 'utf8')).toContain('known good')
  expect(await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8')).toBe(manifestBefore)
})

it('preserves binary companion bytes when an offline copy is read back', async () => {
  const { readWorkspaceSkillFiles } = await import('./skillsInstaller')
  const bytes = Buffer.from([0xff, 0x00, 0x80, 0x01])
  await writeSkillToWorkspace(bundle('binary', [{ relPath: 'SKILL.md', text: 'body' }, { relPath: 'asset.bin', base64: bytes.toString('base64') }] as any))
  const files = await readWorkspaceSkillFiles(h.resolve(), 'local', cwd, 'codex', 'binary')
  expect(files).toContainEqual({ relPath: 'asset.bin', base64: bytes.toString('base64') })
})

it('rejects a different skill claiming an installed destination before replacing bytes', async () => {
  await writeSkillToWorkspace({ ...bundle('review'), skillId: 'a/review' })
  await expect(writeSkillToWorkspace({ ...bundle('review'), skillId: 'b/review', files: [{ relPath: 'SKILL.md', text: 'other' }] })).rejects.toThrow(/owned|conflict|installed/i)
  expect(await fs.readFile(path.join(cwd, '.codex/skills/review/SKILL.md'), 'utf8')).toContain('body')
})
it('retires the old owned destination on rename and uninstalls by recorded identity', async () => {
  const { uninstall } = await import('./skillsInstaller')
  await writeSkillToWorkspace({ ...bundle('old'), skillId: 'stable' })
  await writeSkillToWorkspace({ ...bundle('new'), skillId: 'stable' })
  await expect(fs.stat(path.join(cwd, '.codex/skills/old'))).rejects.toMatchObject({ code: 'ENOENT' })
  await uninstall('stable', 'old', 'codex', cwd)
  await expect(fs.stat(path.join(cwd, '.codex/skills/new'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('rolls bundle bytes back if ownership manifest publication fails', async () => {
  await writeSkillToWorkspace(bundle('owned', [{ relPath: 'SKILL.md', text: 'v1' }]))
  const runtime = h.resolve()
  const rename = runtime.file.rename
  runtime.file.rename = async (from: string, to: string, access?: object) => {
    if (to.replace(/\\/g, '/').endsWith('/.cate/skills.json')) throw new Error('manifest unavailable')
    return rename(from, to, access)
  }
  await expect(writeSkillToWorkspace(bundle('owned', [{ relPath: 'SKILL.md', text: 'v2' }]))).rejects.toThrow('manifest unavailable')
  expect(await fs.readFile(path.join(cwd, '.codex/skills/owned/SKILL.md'), 'utf8')).toContain('v1')
})

it('retains ownership and bytes when uninstall cannot remove its destination', async () => {
  const { uninstall } = await import('./skillsInstaller')
  await writeSkillToWorkspace(bundle('owned'))
  const runtime = h.resolve()
  const remove = runtime.file.remove
  runtime.file.remove = async (target: string, access?: object) => {
    if (target.replace(/\\/g, '/').endsWith('/skills/owned')) throw new Error('removal denied')
    return remove(target, access)
  }
  const rename = runtime.file.rename
  runtime.file.rename = async (from: string, to: string, access?: object) => {
    if (from.replace(/\\/g, '/').endsWith('/skills/owned')) throw new Error('removal denied')
    return rename(from, to, access)
  }
  await expect(uninstall('owned', 'owned', 'codex', cwd)).rejects.toThrow('removal denied')
  const manifest = JSON.parse(await fs.readFile(path.join(cwd, '.cate/skills.json'), 'utf8'))
  expect(manifest.skills).toHaveLength(1)
  expect(await fs.readFile(path.join(cwd, '.codex/skills/owned/SKILL.md'), 'utf8')).toContain('body')
})

it('rolls all consumer roots back when the second publication fails', async () => {
  const targets = await import('./targets')
  const roots = [path.join(cwd, '.codex/skills'), path.join(cwd, '.consumer/skills')]
  const spy = vi.spyOn(targets, 'skillsRootDirs').mockReturnValue(roots)
  try {
    await writeSkillToWorkspace(bundle('owned', [{ relPath: 'SKILL.md', text: 'v1' }]))
    const runtime = h.resolve()
    const rename = runtime.file.rename
    runtime.file.rename = async (from: string, to: string, access?: object) => {
      if (from.includes('.skills-mirror-stage-') && to === path.join(roots[1], 'owned')) throw new Error('second consumer failed')
      return rename(from, to, access)
    }
    await expect(writeSkillToWorkspace(bundle('owned', [{ relPath: 'SKILL.md', text: 'v2' }]))).rejects.toThrow('second consumer failed')
    for (const root of roots) expect(await fs.readFile(path.join(root, 'owned/SKILL.md'), 'utf8')).toContain('v1')
  } finally { spy.mockRestore() }
})
