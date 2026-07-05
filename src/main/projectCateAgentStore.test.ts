import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./cateGitignore', () => ({ ensureCateGitignore: vi.fn(async () => {}) }))

import { loadCateAgentState, saveCateAgentState } from './projectCateAgentStore'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'cate-cate-agent-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('projectCateAgentStore', () => {
  it('defaults to automatic observations on when the file is absent', async () => {
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('round-trips autoObserve', async () => {
    await saveCateAgentState(root, { version: 1, autoObserve: false })
    expect(existsSync(path.join(root, '.cate', 'cateAgent.json'))).toBe(true)
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: false })
  })

  it('defaults autoObserve to true for older files that omit it', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), JSON.stringify({ enabled: true }), 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('coerces a non-boolean autoObserve back to the default', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), JSON.stringify({ autoObserve: 0 }), 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })

  it('returns defaults on unparseable JSON', async () => {
    await fs.mkdir(path.join(root, '.cate'), { recursive: true })
    await fs.writeFile(path.join(root, '.cate', 'cateAgent.json'), 'nope', 'utf-8')
    expect(await loadCateAgentState(root)).toEqual({ version: 1, autoObserve: true })
  })
})
