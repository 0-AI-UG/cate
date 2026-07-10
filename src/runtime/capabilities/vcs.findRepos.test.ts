import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createVcsCapability } from './vcs'

// findRepos scans a directory a bounded depth down and returns the paths that
// are git repos, without descending into the repos it finds (or into
// node_modules and similar heavy dirs). Temp dirs live under os.tmpdir(), which
// pathValidation always allows, so no allowed-root wiring is needed here.

const vcs = createVcsCapability({ env: () => process.env, scopeId: 'vcs-test' })
// Every cwd is validated against the caller's scope; temp dirs are under
// os.tmpdir(), which pathValidation allows for any NAMED scope.
const access = { scopeId: 'vcs-test' }

async function mkGitRepo(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true })
}

describe('vcs.findRepos', () => {
  let root: string

  beforeEach(async () => {
    // Use the mkdtemp path as-is (not realpath'd): pathValidation allows paths
    // under path.resolve(os.tmpdir()), and on macOS realpath would rewrite the
    // /var → /private/var symlink and fall outside that allowed prefix.
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-findrepos-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test('returns the root itself when it is a repo, without scanning children', async () => {
    await mkGitRepo(root)
    await mkGitRepo(path.join(root, 'nested'))
    const repos = await vcs.findRepos(root, undefined, access)
    expect(repos).toEqual([root])
  })

  test('finds repos one level down and skips non-repo folders', async () => {
    await mkGitRepo(path.join(root, 'frontend'))
    await mkGitRepo(path.join(root, 'backend'))
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    const repos = await vcs.findRepos(root, undefined, access)
    expect(repos.sort()).toEqual(
      [path.join(root, 'backend'), path.join(root, 'frontend')].sort(),
    )
  })

  test('does not descend into a found repo (nested repos are ignored at default depth)', async () => {
    await mkGitRepo(path.join(root, 'frontend'))
    await mkGitRepo(path.join(root, 'frontend', 'vendor'))
    const repos = await vcs.findRepos(root, undefined, access)
    expect(repos).toEqual([path.join(root, 'frontend')])
  })

  test('skips node_modules and dot-directories', async () => {
    await mkGitRepo(path.join(root, 'node_modules', 'somepkg'))
    await mkGitRepo(path.join(root, '.cache', 'thing'))
    const repos = await vcs.findRepos(root, undefined, access)
    expect(repos).toEqual([])
  })

  test('returns an empty list when nothing is a repo', async () => {
    await fs.mkdir(path.join(root, 'docs'), { recursive: true })
    await fs.mkdir(path.join(root, 'assets'), { recursive: true })
    expect(await vcs.findRepos(root, undefined, access)).toEqual([])
  })

  test('respects a deeper maxDepth', async () => {
    await mkGitRepo(path.join(root, 'group', 'app'))
    expect(await vcs.findRepos(root, 1, access)).toEqual([])
    expect(await vcs.findRepos(root, 2, access)).toEqual([path.join(root, 'group', 'app')])
  })
})
