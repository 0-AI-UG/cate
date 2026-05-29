import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

const { createBranch } = await import('./git')
const { simpleGit } = await import('simple-git')

describe('createBranch', () => {
  let repoDir: string

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-git-'))
    const git = simpleGit(repoDir)
    await git.init()
    await git.addConfig('user.name', 'Cate Tests')
    await git.addConfig('user.email', 'cate@example.com')
    await fs.writeFile(path.join(repoDir, 'README.md'), 'base\n', 'utf8')
    await git.add('README.md')
    await git.commit('initial')
    // Force-rename the initial branch to `main` rather than creating it: a fresh
    // `git init` may already be on `main` (git's modern default / init.defaultBranch),
    // and `checkout -b main` would then fatal with "already exists".
    await git.branch(['-M', 'main'])
  })

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true })
  })

  test('creates a branch from current HEAD when no start point is provided', async () => {
    await createBranch(repoDir, 'feature/head')
    const git = simpleGit(repoDir)
    const current = await git.revparse(['--abbrev-ref', 'HEAD'])
    expect(current.trim()).toBe('feature/head')
  })

  test('creates a branch from an explicit start point', async () => {
    const git = simpleGit(repoDir)
    await git.checkout('main')
    await git.raw(['tag', 'v1'])

    await fs.writeFile(path.join(repoDir, 'README.md'), 'base\nnext\n', 'utf8')
    await git.add('README.md')
    await git.commit('next')

    await createBranch(repoDir, 'feature/tagged', 'v1')
    const branchHead = (await git.revparse(['HEAD'])).trim()
    const tagHead = (await git.revparse(['v1'])).trim()

    expect(branchHead).toBe(tagHead)
  })
})
