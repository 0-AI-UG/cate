import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { createVcsCapability } from './vcs'

it('prunes stale remote-tracking branches while fetching', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-fetch-'))
  const origin = path.join(base, 'origin.git')
  const seed = path.join(base, 'seed')
  const checkout = path.join(base, 'checkout')
  try {
    await simpleGit().raw(['init', '--bare', origin])
    await fs.mkdir(seed)
    const seedGit = simpleGit(seed)
    await seedGit.init()
    await seedGit.addConfig('user.name', 'Cate Test')
    await seedGit.addConfig('user.email', 'cate@example.com')
    await fs.writeFile(path.join(seed, 'README.md'), 'test\n')
    await seedGit.add('README.md')
    await seedGit.commit('initial')
    await seedGit.branch(['-M', 'main'])
    await seedGit.addRemote('origin', origin)
    await seedGit.push(['-u', 'origin', 'main'])
    await seedGit.checkoutLocalBranch('stale')
    await seedGit.push(['-u', 'origin', 'stale'])
    await simpleGit().clone(origin, checkout)
    await simpleGit(origin).branch(['-D', 'stale'])

    const checkoutGit = simpleGit(checkout)
    expect((await checkoutGit.branch(['-r'])).all).toContain('origin/stale')

    const vcs = createVcsCapability({ env: () => process.env, scopeId: 'fetch-test' })
    await vcs.fetch(checkout, 'origin', { scopeId: 'fetch-test' })

    expect((await checkoutGit.branch(['-r'])).all).not.toContain('origin/stale')
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})
