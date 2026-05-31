import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { ensureCateGitignore } from './cateGitignore'

describe('ensureCateGitignore', () => {
  let root: string

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cate-gitignore-'))
  })

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('creates the dir and writes an ignore-all-but-workspace.json rule', async () => {
    const cateDir = path.join(root, '.cate')
    await ensureCateGitignore(cateDir)

    const content = await fsp.readFile(path.join(cateDir, '.gitignore'), 'utf-8')
    expect(content).toContain('\n*\n')
    expect(content).toContain('!.gitignore')
    expect(content).toContain('!workspace.json')
    // session.json, *.bak, the pi-agent dir and worktrees are all covered by `*`.
    expect(content).not.toContain('session.json')
  })

  it('leaves an existing .gitignore untouched', async () => {
    const cateDir = path.join(root, '.cate')
    await fsp.mkdir(cateDir, { recursive: true })
    await fsp.writeFile(path.join(cateDir, '.gitignore'), 'custom\n', 'utf-8')

    await ensureCateGitignore(cateDir)

    const content = await fsp.readFile(path.join(cateDir, '.gitignore'), 'utf-8')
    expect(content).toBe('custom\n')
  })
})
