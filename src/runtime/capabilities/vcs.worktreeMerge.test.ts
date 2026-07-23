import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createVcsCapability } from './vcs'

const access = { scopeId: 'vcs-merge-test' }

describe('vcs.worktreeMergeTo', () => {
  let root: string
  let primaryBranch: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-vcs-merge-'))
    const git = simpleGit(root)
    await git.init()
    await git.addConfig('user.name', 'Cate Test')
    await git.addConfig('user.email', 'cate@example.test')
    await fs.writeFile(path.join(root, 'shared.txt'), 'base\n')
    await git.add('shared.txt')
    await git.commit('initial')
    primaryBranch = (await git.branchLocal()).current
    await git.checkoutLocalBranch('feature')
    await fs.writeFile(path.join(root, 'shared.txt'), 'feature\n')
    await git.add('shared.txt')
    await git.commit('feature change')
    await git.checkout(primaryBranch)
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function vcs() {
    return createVcsCapability({ env: () => process.env, scopeId: 'vcs-merge-test' })
  }

  test('refuses to merge over uncommitted primary-worktree changes', async () => {
    await fs.writeFile(path.join(root, 'local.txt'), 'uncommitted\n')

    const result = await vcs().worktreeMergeTo(root, 'feature', primaryBranch, access)

    expect(result).toEqual({
      ok: false,
      conflict: false,
      message: `Commit or stash changes in ${primaryBranch} before merging into it.`,
    })
    expect((await simpleGit(root).status()).files).toHaveLength(1)
  })

  test('aborts a conflicting merge and restores a clean primary worktree', async () => {
    const git = simpleGit(root)
    await fs.writeFile(path.join(root, 'shared.txt'), 'primary\n')
    await git.add('shared.txt')
    await git.commit('primary change')

    const result = await vcs().worktreeMergeTo(root, 'feature', primaryBranch, access)

    expect(result).toEqual({
      ok: false,
      conflict: true,
      message: 'The branches have conflicting changes. The merge was aborted.',
    })
    expect((await git.status()).files).toHaveLength(0)
    await expect(fs.stat(path.join(root, '.git', 'MERGE_HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await git.branchLocal()).current).toBe(primaryBranch)
  })
})
