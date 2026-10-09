import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { computeBuildId } from './build-id.mjs'

let dir
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function repo() {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cate-build-id-'))
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), text)
  }
  write('package.json', '{"version":"1.0.0"}')
  write('package-lock.json', '{"lockfileVersion":3}')
  write('src/kernel/a.ts', 'export const a = 1\n')
  write('skills/cate-cli/SKILL.md', '# cate\n')
  write('scripts/patch-t3.mjs', '// patch\n')
  write('scripts/patch-t3-client.mjs', '// patch client\n')
  return write
}

it('changes with every input of the install', () => {
  const write = repo()
  let id = computeBuildId(dir)
  for (const [file, text] of [
    ['src/kernel/a.ts', 'export const a = 2\n'],
    ['skills/cate-cli/SKILL.md', '# cate, changed\n'],
    ['scripts/patch-t3.mjs', '// patch 2\n'],
    ['scripts/patch-t3-client.mjs', '// patch client 2\n'],
    ['package-lock.json', '{"lockfileVersion":3,"x":1}'],
  ]) {
    write(file, text)
    const next = computeBuildId(dir)
    expect(next, file).not.toBe(id)
    id = next
  }
})
