import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

import { loadPetState, savePetState } from './projectPetStore'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-pet-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectPetStore', () => {
  it('defaults to disabled when the file is absent', async () => {
    expect(await loadPetState(root)).toEqual({ version: 1, enabled: false, paused: false })
  })

  it('round-trips enabled + paused', async () => {
    await savePetState(root, { version: 1, enabled: true, paused: true })
    expect(existsSync(path.join(root, '.cate', 'pet.json'))).toBe(true)
    expect(await loadPetState(root)).toEqual({ version: 1, enabled: true, paused: true })
  })

  it('coerces non-boolean fields back to defaults', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'pet.json'), JSON.stringify({ enabled: 'yes', paused: 1 }), 'utf-8')
    expect(await loadPetState(root)).toEqual({ version: 1, enabled: false, paused: false })
  })

  it('returns defaults on unparseable JSON', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'pet.json'), 'nope', 'utf-8')
    expect(await loadPetState(root)).toEqual({ version: 1, enabled: false, paused: false })
  })
})
