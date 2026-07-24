import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { simpleGit } from 'simple-git'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createVcsCapability } from './vcs'

const posixTest = process.platform === 'win32' ? test.skip : test
const access = { scopeId: 'vcs-pr-test' }

describe('vcs.worktreeAddFromPr', () => {
  let root: string
  let binDir: string
  let target: string
  let failCheckout = false

  beforeEach(async () => {
    failCheckout = false
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-vcs-pr-'))
    binDir = path.join(root, 'bin')
    target = path.join(root, '.cate', 'worktrees', 'pr-525-feature')
    await fs.mkdir(binDir)
    await fs.writeFile(path.join(binDir, 'gh'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "gh version test"
  exit 0
fi
if [ "$CATE_TEST_GH_FAIL" = "1" ]; then
  echo "hint: Diverging branches can't be fast-forwarded" >&2
  echo "fatal: Not possible to fast-forward, aborting." >&2
  exit 1
fi
previous=""
for argument in "$@"; do
  if [ "$previous" = "--branch" ]; then branch="$argument"; fi
  previous="$argument"
done
git switch --create "$branch"
`)
    await fs.chmod(path.join(binDir, 'gh'), 0o755)

    const git = simpleGit(root)
    await git.init()
    await git.addConfig('user.name', 'Cate Test')
    await git.addConfig('user.email', 'cate@example.test')
    await fs.writeFile(path.join(root, 'README.md'), 'initial\n')
    await git.add('README.md')
    await git.commit('initial')
    const primaryBranch = (await git.branchLocal()).current
    await git.branch(['feature'])
    await git.checkout('feature')
    await fs.writeFile(path.join(root, 'FEATURE.md'), 'contributor work\n')
    await git.add('FEATURE.md')
    await git.commit('feature work')
    await git.checkout(primaryBranch)
    await fs.writeFile(path.join(root, 'README.md'), 'main moved on\n')
    await git.add('README.md')
    await git.commit('main work')
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  function vcs() {
    return createVcsCapability({
      env: () => ({
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        CATE_TEST_GH_FAIL: failCheckout ? '1' : '0',
      }),
      scopeId: 'vcs-pr-test',
    })
  }

  posixTest('uses an isolated branch instead of the PR head branch', async () => {
    const result = await vcs().worktreeAddFromPr(root, 525, target, undefined, access)

    expect(result).toEqual({ path: target, branch: 'cate-pr-525' })
    expect((await simpleGit(target).branchLocal()).current).toBe('cate-pr-525')
    expect((await simpleGit(root).branchLocal()).all).toContain('feature')
  })

  posixTest('chooses a fresh suffix when a previous Cate PR branch exists', async () => {
    await simpleGit(root).branch(['cate-pr-525'])

    const result = await vcs().worktreeAddFromPr(root, 525, target, undefined, access)

    expect(result.branch).toBe('cate-pr-525-2')
  })

  posixTest('removes the partial worktree and returns a concise checkout error', async () => {
    failCheckout = true

    await expect(vcs().worktreeAddFromPr(root, 525, target, undefined, access)).rejects.toThrow(
      'Couldn’t check out PR #525. Check that GitHub CLI can access this repository, then try again.',
    )
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await simpleGit(root).branchLocal()).all).not.toContain('cate-pr-525')
  })
})
