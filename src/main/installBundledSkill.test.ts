import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getAppPath: () => h.root, getPath: () => h.root } }))
vi.mock('os', async original => ({ ...(await original<typeof import('node:os')>()), default: { ...(await original<typeof import('node:os')>()), homedir: () => h.root } }))
import { installBundledSkill } from './installBundledSkill'
afterEach(async () => { if (h.root) await fs.rm(h.root, { recursive: true, force: true }) })
it('updates owned bundled files while preserving user edits and retiring removed companions', async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-bundled-update-'))
  const source = path.join(h.root, 'skills/demo')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), 'v1')
  await fs.writeFile(path.join(source, 'old.md'), 'retired')
  await fs.writeFile(path.join(source, 'edited.md'), 'original')
  await installBundledSkill('demo')
  const dest = path.join(h.root, '.claude/skills/demo')
  await fs.writeFile(path.join(dest, 'edited.md'), 'user edit')
  await fs.writeFile(path.join(source, 'SKILL.md'), 'v2')
  await fs.rm(path.join(source, 'old.md'))
  await installBundledSkill('demo')
  expect(await fs.readFile(path.join(dest, 'SKILL.md'), 'utf8')).toBe('v2')
  expect(await fs.readFile(path.join(dest, 'edited.md'), 'utf8')).toBe('user edit')
  await expect(fs.stat(path.join(dest, 'old.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('retains managed ownership after a manifest publication failure and retry', async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-bundled-manifest-'))
  const source = path.join(h.root, 'skills/demo')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(path.join(source, 'SKILL.md'), 'v1')
  const { localSkillFiles } = await import('../skills/main/localSkillFiles')
  const rename = localSkillFiles.file.rename
  const failed = vi.spyOn(localSkillFiles.file, 'rename').mockImplementation(async (from, to) => {
    if (to.endsWith('/.cate/demo.json')) throw new Error('manifest unavailable')
    return rename(from, to)
  })
  await installBundledSkill('demo')
  failed.mockRestore()
  await installBundledSkill('demo')
  await fs.writeFile(path.join(source, 'SKILL.md'), 'v2')
  await installBundledSkill('demo')
  expect(await fs.readFile(path.join(h.root, '.claude/skills/demo/SKILL.md'), 'utf8')).toBe('v2')
})
