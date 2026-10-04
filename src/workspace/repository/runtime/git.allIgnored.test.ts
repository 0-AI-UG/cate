import { expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { testGitHost } from './testGit'

it('reports whether git ignores every changed path', async () => {
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cate-ignored-')))
  try {
    await simpleGit(repo).init()
    await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n')
    const git = testGitHost()
    const dist = path.join(repo, 'dist', 'a.js')
    const src = path.join(repo, 'src', 'main.ts')
    expect(await git.allIgnored({ cwd: repo, paths: [dist, path.join(repo, 'dist', 'b.js')] })).toBe(true)
    expect(await git.allIgnored({ cwd: repo, paths: [dist, src] })).toBe(false)
    expect(await git.allIgnored({ cwd: repo, paths: [src] })).toBe(false)
  } finally {
    await fs.rm(repo, { recursive: true, force: true })
  }
})
