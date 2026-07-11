// The git-missing guard: on a host without git, every VcsHost op that spawns
// git must fail with the actionable GIT_MISSING message instead of a raw
// `spawn git ENOENT`. Forced by pointing PATH at an empty temp dir (POSIX-only:
// win32 binary resolution goes through PATHEXT and shells with different
// failure shapes).

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createVcsCapability } from './vcs'

const posixTest = process.platform === 'win32' ? test.skip : test

const access = { scopeId: 'vcs-test' }

describe('vcs — git missing on host', () => {
  let root: string
  let oldPath: string | undefined

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-nogit-'))
    oldPath = process.env.PATH
  })

  afterEach(async () => {
    process.env.PATH = oldPath
    await fs.rm(root, { recursive: true, force: true })
  })

  posixTest('status fails with the clear install-git message, not a raw spawn error', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    // simple-git resolves `git` off process.env at spawn time; the guard's
    // probe uses the injected env. Point both at an empty dir.
    process.env.PATH = root
    const vcs = createVcsCapability({ env: () => ({ PATH: root }), scopeId: 'vcs-test' })
    await expect(vcs.status(root, access)).rejects.toThrow(/git was not found on this host/)
  })

  posixTest('ops that never spawn git are unaffected', async () => {
    process.env.PATH = root
    const vcs = createVcsCapability({ env: () => ({ PATH: root }), scopeId: 'vcs-test' })
    // isRepo is an fs check (.git presence), no git binary involved.
    expect(await vcs.isRepo(root, access)).toBe(false)
    await fs.mkdir(path.join(root, '.git'), { recursive: true })
    expect(await vcs.isRepo(root, access)).toBe(true)
  })
})
