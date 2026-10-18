// Seeding the bundled cate-cli skill: dir-presence gating, version-hashed
// markers (a changed bundle refreshes an unedited copy; edits survive,
// uninstalls stick) and marker-only handling of a manual install. Uses the
// real bundled skills/ dir of this repo.

import { createHash } from 'node:crypto'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '@kernel/log/contract'
import { createDirLocks, nodeSkillFiles, type SkillFiles } from './files'
import { createSkillInstaller } from './installer'
import { createSkillSeeder } from './seed'
import { createTargetTable } from './targets'
import { memorySkillFiles, TEST_TARGETS } from './testSupport'

const BUNDLED = path.join(process.cwd(), 'skills')
const WS = '/ws'
const MANIFEST = `${WS}/.cate/skills.json`
const CLAUDE_DIR = `${WS}/.claude/skills/cate-cli`
const CLAUDE_SKILL = `${CLAUDE_DIR}/SKILL.md`
const markerFor = (target: string) => new RegExp(`^cate/cate-cli:${target}@[0-9a-f]{12}$`)
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

let files: Map<string, string>
let dirs: Set<string>
let seed: () => Promise<void>

// Workspace paths are in memory; the bundled dir is read from disk.
function hybrid(memory: SkillFiles): SkillFiles {
  const pick = (p: string) => (p.startsWith(BUNDLED) ? nodeSkillFiles : memory)
  return {
    readFile: (p) => pick(p).readFile(p),
    readBinary: (p) => pick(p).readBinary(p),
    writeFile: (p, t) => memory.writeFile(p, t),
    writeBinary: (p, b) => memory.writeBinary(p, b),
    mkdir: (p) => memory.mkdir(p),
    remove: (p) => memory.remove(p),
    rename: (a, b) => memory.rename(a, b),
    stat: (p) => pick(p).stat(p),
    readDir: (p) => pick(p).readDir(p),
  }
}

/** The seeder's hash of what is installed in the Claude Code dir now. */
function installedHash(): string {
  const h = createHash('sha256')
  const installed = [...files].filter(([p]) => p.startsWith(`${CLAUDE_DIR}/`)).map(([p, text]) => [p.slice(CLAUDE_DIR.length + 1), text])
  for (const [rel, text] of installed.sort(([a], [b]) => a.localeCompare(b))) h.update(rel).update('\0').update(text).update('\0')
  return h.digest('hex').slice(0, 12)
}

const manifest = () => JSON.parse(files.get(MANIFEST) ?? '{"skills":[]}') as { skills: Array<{ skillId: string; targetId: string }>; seeded?: string[] }

beforeEach(() => {
  files = new Map()
  dirs = new Set([WS])
  const host = hybrid(memorySkillFiles(files, dirs))
  const targets = createTargetTable(TEST_TARGETS)
  const withDirs = createDirLocks()
  const installer = createSkillInstaller({ files: host, targets, withDirs })
  const seeder = createSkillSeeder({ files: host, targets, installer, withDirs, bundledSkillsDir: BUNDLED, log: createLogger('test') })
  seed = () => seeder.seed(WS, ['cate-cli'])
})

describe('seeding bundled skills', () => {
  it('skips targets whose tool dir is absent', async () => {
    await seed()
    expect(files.has(CLAUDE_SKILL)).toBe(false)
    expect(manifest()).toEqual({ skills: [] })
  })

  it('seeds a target once its tool dir exists', async () => {
    await seed()
    dirs.add(`${WS}/.claude`)
    await seed()
    expect(files.has(CLAUDE_SKILL)).toBe(true)
    expect(manifest().seeded).toEqual([expect.stringMatching(markerFor('claude-code'))])
  })

  it('never rewrites a seeded copy the user edited', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    files.set(CLAUDE_SKILL, 'user edited')
    await seed()
    expect(files.get(CLAUDE_SKILL)).toBe('user edited')
  })

  it('an uninstall sticks', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    files.delete(CLAUDE_SKILL)
    files.set(MANIFEST, JSON.stringify({ skills: [], seeded: ['cate/cate-cli:claude-code'] }))
    await seed()
    expect(files.has(CLAUDE_SKILL)).toBe(false)
  })

  it('a manual install just gets its marker', async () => {
    dirs.add(`${WS}/.claude`)
    files.set(CLAUDE_SKILL, 'manually installed, edited')
    files.set(MANIFEST, JSON.stringify({ skills: [{ skillId: 'cate/cate-cli', name: 'cate-cli', targetId: 'claude-code', path: CLAUDE_SKILL, origin: 'local' }] }))
    await seed()
    expect(files.get(CLAUDE_SKILL)).toBe('manually installed, edited')
    expect(manifest().seeded).toEqual([expect.stringMatching(markerFor('claude-code'))])
  })

  it('refreshes an unedited copy from an older bundle', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    files.set(CLAUDE_SKILL, 'old bundle content')
    const old = installedHash()
    files.set(MANIFEST, JSON.stringify({ skills: manifest().skills, seeded: [`cate/cate-cli:claude-code@${old}`] }))
    await seed()
    expect(files.get(CLAUDE_SKILL)).toContain('name: cate-cli')
    expect(manifest().seeded![0]).not.toContain(old)
  })

  it('a refresh adds new bundle files and retires dropped ones', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    const current = [...files.keys()].filter((p) => p.startsWith(`${CLAUDE_DIR}/references/`))
    expect(current.length).toBeGreaterThan(0)
    // An older bundle: a different SKILL.md and a reference file since dropped.
    for (const p of current) files.delete(p)
    files.set(CLAUDE_SKILL, 'old bundle content')
    files.set(`${CLAUDE_DIR}/references/retired.md`, 'retired')
    const [row] = manifest().skills
    const managedFiles = { 'SKILL.md': sha256('old bundle content'), 'references/retired.md': sha256('retired') }
    files.set(MANIFEST, JSON.stringify({ skills: [{ ...row, managedFiles }], seeded: [`cate/cate-cli:claude-code@${installedHash()}`] }))
    await seed()
    expect(files.get(CLAUDE_SKILL)).toContain('name: cate-cli')
    expect(files.has(`${CLAUDE_DIR}/references/retired.md`)).toBe(false)
    for (const p of current) expect(files.has(p)).toBe(true)
  })

  it('an edited reference file keeps the whole copy', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    const reference = [...files.keys()].find((p) => p.startsWith(`${CLAUDE_DIR}/references/`))!
    files.set(reference, 'user edited')
    files.set(MANIFEST, JSON.stringify({ skills: manifest().skills, seeded: ['cate/cate-cli:claude-code@000000000000'] }))
    await seed()
    expect(files.get(reference)).toBe('user edited')
  })

  it('never overwrites an edited copy across bundle versions', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    files.set(CLAUDE_SKILL, 'user edited')
    files.set(MANIFEST, JSON.stringify({ skills: manifest().skills, seeded: ['cate/cate-cli:claude-code@000000000000'] }))
    await seed()
    expect(files.get(CLAUDE_SKILL)).toBe('user edited')
    expect(manifest().seeded).toEqual(['cate/cate-cli:claude-code@000000000000'])
  })

  it('a hash-less marker gets one refresh', async () => {
    dirs.add(`${WS}/.claude`)
    await seed()
    files.set(CLAUDE_SKILL, 'stale doc')
    files.set(MANIFEST, JSON.stringify({ skills: manifest().skills, seeded: ['cate/cate-cli:claude-code'] }))
    await seed()
    expect(files.get(CLAUDE_SKILL)).toContain('name: cate-cli')
    expect(manifest().seeded).toEqual([expect.stringMatching(markerFor('claude-code'))])
  })
})
