import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.root } }))
vi.mock('../../main/logger', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve: vi.fn() } }))
vi.mock('./skillSources', () => ({ getToken: () => undefined }))
vi.mock('./githubCrawl', () => ({ fetchSkillFiles: async () => [{ relPath: 'SKILL.md', text: 'known good' }] }))
const entry = { id: 'owner/repo/demo', name: 'Demo', description: '', tags: [], format: 'skill-md' as const, source: { repo: 'owner/repo', ref: 'main', path: 'demo' }, provenance: 'curated' as const, sourceId: 'owner/repo' }
beforeEach(async () => { h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-library-tx-')); vi.resetModules() })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(h.root, { recursive: true, force: true }) })
function failNextMetadataPublication(): void {
  const rename = fs.rename
  let fail = true
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith('/saved-skills.json')) { fail = false; throw new Error('metadata unavailable') }
    return rename(from, to)
  })
}
it('restores cached bytes and the star when unsave metadata fails', async () => {
  const { saveSkill, unsaveSkill } = await import('./skillsInstaller')
  const saved = await import('./savedSkills')
  const cache = await import('./skillStore')
  await saveSkill(entry)
  failNextMetadataPublication()
  await expect(unsaveSkill(entry.id)).rejects.toThrow('metadata unavailable')
  expect(saved.isSaved(entry.id)).toBe(true)
  expect(await cache.read(entry.id)).toEqual([{ relPath: 'SKILL.md', text: 'known good' }])
  expect(JSON.parse(await fs.readFile(path.join(h.root, 'saved-skills.json'), 'utf8')).skills).toHaveLength(1)
})
it('rolls back newly cached bytes if the star cannot become durable', async () => {
  const { saveSkill } = await import('./skillsInstaller')
  const saved = await import('./savedSkills')
  const cache = await import('./skillStore')
  failNextMetadataPublication()
  await expect(saveSkill(entry)).rejects.toThrow('metadata unavailable')
  expect(saved.isSaved(entry.id)).toBe(false)
  expect(await cache.has(entry.id)).toBe(false)
})
