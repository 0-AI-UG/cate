// Coverage for seedCateCliSkill: the cliSkillInstallEnabled gate, cate-agent
// always seeded, dir-presence gating for other targets, version-hashed seed
// markers (a changed bundle refreshes an unedited copy; edits are never
// clobbered, uninstalls stick), and marker-only handling of a pre-existing
// manual install. Uses an in-memory fake runtime.file and the REAL bundled
// skills/cate-cli dir (app.getAppPath() → repo root).

import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const settingsState = vi.hoisted(() => ({ cliSkillInstallEnabled: true as unknown }))
const resolve = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))
vi.mock('../../main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../main/settingsFile', () => ({
  getSetting: (k: string) => (settingsState as Record<string, unknown>)[k],
}))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve } }))

import { seedCateCliSkill } from './seedCateCliSkill'

const WS = '/ws'
const MANIFEST = `${WS}/.cate/skills.json`
const CATE_AGENT_SKILL = `${WS}/.cate/cate-agent/skills/cate-cli/SKILL.md`
const CLAUDE_SKILL = `${WS}/.claude/skills/cate-cli/SKILL.md`
/** Versioned seed marker for a target: `<skillId>:<target>@<12-hex hash>`. */
const markerFor = (target: string) => new RegExp(`^cate/cate-cli:${target}@[0-9a-f]{12}$`)

/** The seeder's content hash for a single-SKILL.md install with `text`. */
function hashOf(text: string): string {
  return crypto.createHash('sha256').update('SKILL.md').update('\0').update(text).update('\0').digest('hex').slice(0, 12)
}

// In-memory host filesystem behind runtime.file. mkdir is lax about parents —
// the installer's mkdirp walks level-by-level anyway. Keys are normalized to
// forward slashes: the local runtime builds paths with path.join, which uses
// backslashes on Windows, while the test constants are POSIX.
let files: Map<string, string>
let dirs: Set<string>

const norm = (p: string): string => p.replace(/\\/g, '/')

function makeRuntime() {
  return {
    file: {
      readFile: async (p: string) => {
        const v = files.get(norm(p))
        if (v === undefined) throw new Error(`ENOENT: ${p}`)
        return v
      },
      writeFile: async (p: string, content: string) => {
        files.set(norm(p), content)
      },
      writeBinary: async (p: string, buf: Buffer) => {
        files.set(norm(p), buf.toString('utf8'))
      },
      mkdir: async (p: string) => {
        dirs.add(norm(p))
      },
      stat: async (p: string) => {
        if (dirs.has(norm(p))) return { isDirectory: true, isFile: false }
        if (files.has(norm(p))) return { isDirectory: false, isFile: true }
        throw new Error(`ENOENT: ${p}`)
      },
      // Shallow listing derived from the flat file map (the seeder reads an
      // install back through this to hash it).
      readDir: async (p: string) => {
        const prefix = `${norm(p)}/`
        const out = new Map<string, { name: string; isDirectory: boolean }>()
        for (const key of files.keys()) {
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          const name = rest.split('/')[0]
          if (name) out.set(name, { name, isDirectory: rest.includes('/') })
        }
        return [...out.values()]
      },
    },
  }
}

function manifest(): { skills: Array<{ skillId: string; targetId: string }>; seeded?: string[] } {
  return JSON.parse(files.get(MANIFEST) ?? '{"skills":[]}')
}

beforeEach(() => {
  settingsState.cliSkillInstallEnabled = true
  files = new Map()
  dirs = new Set([WS])
  resolve.mockReset()
  resolve.mockReturnValue(makeRuntime())
})

describe('seedCateCliSkill', () => {
  it('does nothing when the setting is off', async () => {
    settingsState.cliSkillInstallEnabled = false
    await seedCateCliSkill(WS)
    expect(files.size).toBe(0)
  })

  it('seeds cate-agent always, skips targets whose tool dir is absent', async () => {
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toContain('name: cate-cli')
    expect(files.has(CLAUDE_SKILL)).toBe(false)
    const m = manifest()
    expect(m.skills).toEqual([expect.objectContaining({ skillId: 'cate/cate-cli', targetId: 'cate-agent' })])
    expect(m.seeded).toEqual([expect.stringMatching(markerFor('cate-agent'))])
  })

  it('seeds a target once its tool dir exists', async () => {
    dirs.add(`${WS}/.claude`)
    await seedCateCliSkill(WS)
    expect(files.has(CLAUDE_SKILL)).toBe(true)
    const m = manifest()
    expect(m.seeded).toEqual(expect.arrayContaining([
      expect.stringMatching(markerFor('claude-code')),
      expect.stringMatching(markerFor('cate-agent')),
    ]))
  })

  it('a tool dir appearing later is picked up by the next open', async () => {
    await seedCateCliSkill(WS)
    expect(files.has(CLAUDE_SKILL)).toBe(false)
    dirs.add(`${WS}/.claude`)
    await seedCateCliSkill(WS)
    expect(files.has(CLAUDE_SKILL)).toBe(true)
  })

  it('never rewrites a seeded copy (edits survive re-open)', async () => {
    await seedCateCliSkill(WS)
    files.set(CATE_AGENT_SKILL, 'user edited')
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toBe('user edited')
  })

  it('an uninstall sticks: marker present but skill gone -> not reinstalled', async () => {
    await seedCateCliSkill(WS)
    // Simulate the modal's uninstall: file and manifest entry removed, marker kept.
    files.delete(CATE_AGENT_SKILL)
    files.set(MANIFEST, JSON.stringify({ skills: [], seeded: ['cate/cate-cli:cate-agent'] }))
    await seedCateCliSkill(WS)
    expect(files.has(CATE_AGENT_SKILL)).toBe(false)
  })

  it('a pre-existing manual install just gets its marker, no overwrite', async () => {
    files.set(CATE_AGENT_SKILL, 'manually installed, edited')
    files.set(
      MANIFEST,
      JSON.stringify({ skills: [{ skillId: 'cate/cate-cli', name: 'cate-cli', targetId: 'cate-agent', path: CATE_AGENT_SKILL, origin: 'local' }] }),
    )
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toBe('manually installed, edited')
    expect(manifest().seeded).toEqual(expect.arrayContaining([expect.stringMatching(markerFor('cate-agent'))]))
  })

  it('refreshes an unedited copy from an older bundle', async () => {
    await seedCateCliSkill(WS)
    // Rewind the install to an "older bundle": old content plus a marker
    // carrying that content's hash (what the older app would have written).
    const old = 'old bundle content'
    const m = manifest()
    files.set(CATE_AGENT_SKILL, old)
    files.set(MANIFEST, JSON.stringify({ skills: m.skills, seeded: [`cate/cate-cli:cate-agent@${hashOf(old)}`] }))
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toContain('name: cate-cli')
    expect(manifest().seeded).toEqual([expect.stringMatching(markerFor('cate-agent'))])
    expect(manifest().seeded![0]).not.toContain(hashOf(old))
  })

  it('never overwrites an edited copy, even across bundle versions', async () => {
    await seedCateCliSkill(WS)
    // Seeded by an old bundle (marker hash ≠ current bundle) and then edited by
    // the user (content hash ≠ marker hash): the edit wins, the marker stays.
    const m = manifest()
    files.set(CATE_AGENT_SKILL, 'user edited')
    files.set(MANIFEST, JSON.stringify({ skills: m.skills, seeded: ['cate/cate-cli:cate-agent@000000000000'] }))
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toBe('user edited')
    expect(manifest().seeded).toEqual(['cate/cate-cli:cate-agent@000000000000'])
  })

  it('a pre-hash marker migrates: the copy is refreshed and the marker gains a hash', async () => {
    await seedCateCliSkill(WS)
    const m = manifest()
    files.set(CATE_AGENT_SKILL, 'stale pre-rework doc')
    files.set(MANIFEST, JSON.stringify({ skills: m.skills, seeded: ['cate/cate-cli:cate-agent'] }))
    await seedCateCliSkill(WS)
    expect(files.get(CATE_AGENT_SKILL)).toContain('name: cate-cli')
    expect(manifest().seeded).toEqual([expect.stringMatching(markerFor('cate-agent'))])
  })

  it('is a no-op when the runtime is not connected yet', async () => {
    resolve.mockImplementation(() => {
      throw new Error('not connected')
    })
    await expect(seedCateCliSkill(WS)).resolves.toBeUndefined()
    expect(files.size).toBe(0)
  })
})
