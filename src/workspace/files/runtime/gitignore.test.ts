import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CATE_GITIGNORE } from '../contract'
import { ensureCateGitignore } from './gitignore'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-gitignore-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

it('writes the ignore-all-but-skills .cate/.gitignore once', async () => {
  await ensureCateGitignore(dir)
  const file = path.join(dir, '.cate', '.gitignore')
  expect(await fs.readFile(file, 'utf8')).toBe(CATE_GITIGNORE)
  expect(CATE_GITIGNORE).toContain('!skills.json')
  await fs.writeFile(file, 'custom\n')
  await ensureCateGitignore(dir)
  expect(await fs.readFile(file, 'utf8')).toBe('custom\n')
})
