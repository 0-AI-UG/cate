import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import simpleGit from 'simple-git'
import { testGitHost } from './testGit'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-web-url-'))
  await simpleGit(root).init(['--initial-branch=feature/x'])
  await fs.mkdir(path.join(root, 'src dir'), { recursive: true })
  await fs.writeFile(path.join(root, 'src dir', 'a#b.ts'), '')
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

it('builds the GitHub blob URL of a file at the current branch', async () => {
  await simpleGit(root).addRemote('origin', 'git@github.com:org/repo.git')
  expect(await testGitHost().fileWebUrl({ path: path.join(root, 'src dir', 'a#b.ts') }))
    .toEqual({ url: 'https://github.com/org/repo/blob/feature%2Fx/src%20dir/a%23b.ts' })
})

it('is null without a GitHub origin', async () => {
  const file = path.join(root, 'src dir', 'a#b.ts')
  expect(await testGitHost().fileWebUrl({ path: file })).toBeNull()
  await simpleGit(root).addRemote('origin', 'https://gitlab.com/org/repo.git')
  expect(await testGitHost().fileWebUrl({ path: file })).toBeNull()
})

it('is null outside a repository', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-web-url-none-'))
  try {
    expect(await testGitHost().fileWebUrl({ path: path.join(outside, 'x.ts') })).toBeNull()
  } finally {
    await fs.rm(outside, { recursive: true, force: true })
  }
})
