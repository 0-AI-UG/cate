import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { createVcsCapability } from './vcs'
it('reads named fetch/push remotes through the scoped VCS capability', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-remotes-'))
  try {
    const git = simpleGit(root)
    await git.init()
    await git.addRemote('origin', 'git@github.com:org/repo.git')
    await git.raw(['remote', 'set-url', '--push', 'origin', 'https://github.com/org/fork.git'])
    const vcs = createVcsCapability({ env: () => process.env, scopeId: 'remotes-test' })
    expect(await vcs.remotes(root, { scopeId: 'remotes-test' })).toEqual([{ name: 'origin', fetchUrl: 'git@github.com:org/repo.git', pushUrl: 'https://github.com/org/fork.git' }])
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
