import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { testGitHost } from './testGit'

// findRepos scans a directory a bounded depth down and returns the paths that
// are git repos, without descending into the repos it finds (or into
// node_modules and similar heavy dirs).

const vcs = testGitHost()

async function mkGitRepo(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
}

describe('vcs.findRepos', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-findrepos-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test('returns the root itself when it is a repo, without scanning children', async () => {
    await mkGitRepo(root)
    await mkGitRepo(path.join(root, 'nested'))
    const repos = await vcs.findRepos({ dir: root })
    expect(repos).toEqual([root])
  })

  test('finds repos one level down and skips non-repo folders', async () => {
    await mkGitRepo(path.join(root, 'frontend'))
    await mkGitRepo(path.join(root, 'backend'))
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    const repos = await vcs.findRepos({ dir: root })
    expect(repos.sort()).toEqual(
      [path.join(root, 'backend'), path.join(root, 'frontend')].sort(),
    )
  })

  test('does not descend into a found repo (nested repos are ignored at default depth)', async () => {
    await mkGitRepo(path.join(root, 'frontend'))
    await mkGitRepo(path.join(root, 'frontend', 'vendor'))
    const repos = await vcs.findRepos({ dir: root })
    expect(repos).toEqual([path.join(root, 'frontend')])
  })

  test('skips node_modules and dot-directories', async () => {
    await mkGitRepo(path.join(root, 'node_modules', 'somepkg'))
    await mkGitRepo(path.join(root, '.cache', 'thing'))
    const repos = await vcs.findRepos({ dir: root })
    expect(repos).toEqual([])
  })

  test('returns an empty list when nothing is a repo', async () => {
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    expect(await vcs.findRepos({ dir: root })).toEqual([])
  })

  test('respects a deeper maxDepth', async () => {
    await mkGitRepo(path.join(root, 'group', 'app'))
    expect(await vcs.findRepos({ dir: root, maxDepth: 1 })).toEqual([])
    expect(await vcs.findRepos({ dir: root, maxDepth: 2 })).toEqual([path.join(root, 'group', 'app')])
  })
})
