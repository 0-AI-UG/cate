import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const h = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => h.root } }))
vi.mock('../../main/logger', () => ({ default: { warn: vi.fn(), error: vi.fn() } }))
afterEach(async () => { if (h.root) await fs.rm(h.root, { recursive: true, force: true }) })
it('publishes saved metadata before its public mutation resolves', async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-saved-durable-'))
  vi.resetModules()
  const saved = await import('./savedSkills')
  await saved.addSaved({ skillId: 'demo', name: 'Demo', description: '', source: { repo: 'owner/repo', ref: 'main', path: 'demo' } })
  expect(JSON.parse(await fs.readFile(path.join(h.root, 'saved-skills.json'), 'utf8')).skills).toHaveLength(1)
  await saved.removeSaved('demo')
  expect(JSON.parse(await fs.readFile(path.join(h.root, 'saved-skills.json'), 'utf8')).skills).toEqual([])
})

it('rejects failed metadata publication without leaving rejected in-memory ownership', async () => {
  h.root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-saved-failure-'))
  vi.resetModules()
  const saved = await import('./savedSkills')
  const rename = fs.rename
  let fail = true
  const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (fail && String(to).endsWith('/saved-skills.json')) { fail = false; throw new Error('metadata unavailable') }
    return rename(from, to)
  })
  try {
    await expect(saved.addSaved({ skillId: 'demo', name: 'Demo', description: '', source: { repo: 'owner/repo', ref: 'main', path: 'demo' } })).rejects.toThrow('metadata unavailable')
    expect(saved.listSaved()).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(h.root, 'saved-skills.json'), 'utf8')).skills).toEqual([])
  } finally { spy.mockRestore() }
})
