import { beforeEach, describe, expect, it, vi } from 'vitest'

const resolve = vi.hoisted(() => vi.fn())
const logWarn = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }))
vi.mock('../../main/logger', () => ({ default: { warn: logWarn } }))
vi.mock('../../main/runtime/runtimeManager', () => ({ runtimes: { resolve } }))

import { syncWorkspaceSkills } from './skillsMirror'

function normalize(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
}

function parent(value: string): string {
  const normalized = normalize(value)
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/'
}

let renameFailure: ((oldPath: string, newPath: string) => boolean) | null

function makeMemoryFs() {
  const dirs = new Set<string>(['/'])
  const files = new Map<string, Buffer>()
  const runtime = {
    file: {
      readFile: async (path: string) => {
        const contents = files.get(normalize(path))
        if (!contents) throw new Error(`ENOENT: ${path}`)
        return contents.toString('utf8')
      },
      readBinary: async (path: string) => {
        const contents = files.get(normalize(path))
        if (!contents) throw new Error(`ENOENT: ${path}`)
        return Buffer.from(contents)
      },
      writeFile: async (path: string, contents: string) => {
        files.set(normalize(path), Buffer.from(contents))
        return path
      },
      writeBinary: async (path: string, contents: Buffer) => {
        files.set(normalize(path), Buffer.from(contents))
        return path
      },
      readDir: async (path: string) => {
        const dir = normalize(path)
        if (!dirs.has(dir)) throw new Error(`ENOENT: ${path}`)
        const names = new Map<string, boolean>()
        for (const candidate of dirs) {
          if (candidate !== dir && parent(candidate) === dir) {
            names.set(candidate.slice(dir === '/' ? 1 : dir.length + 1), true)
          }
        }
        for (const candidate of files.keys()) {
          if (parent(candidate) === dir) {
            names.set(candidate.slice(dir === '/' ? 1 : dir.length + 1), false)
          }
        }
        return [...names].map(([name, isDirectory]) => ({
          name,
          path: `${dir}/${name}`,
          isDirectory,
          isExpanded: false,
          children: [],
          fileExtension: '',
        }))
      },
      stat: async (path: string) => {
        const normalized = normalize(path)
        if (dirs.has(normalized)) return { isDirectory: true, isFile: false }
        if (files.has(normalized)) return { isDirectory: false, isFile: true }
        throw new Error(`ENOENT: ${path}`)
      },
      remove: async (path: string) => {
        const normalized = normalize(path)
        const prefix = `${normalized}/`
        const existed = files.delete(normalized) || dirs.has(normalized)
        for (const candidate of [...files.keys()]) {
          if (candidate.startsWith(prefix)) files.delete(candidate)
        }
        for (const candidate of [...dirs]) {
          if (candidate === normalized || candidate.startsWith(prefix)) dirs.delete(candidate)
        }
        if (!existed) throw new Error(`ENOENT: ${path}`)
      },
      rename: async (oldPath: string, newPath: string) => {
        if (renameFailure?.(normalize(oldPath), normalize(newPath))) {
          throw new Error('injected rename failure')
        }
        const oldNormalized = normalize(oldPath)
        const newNormalized = normalize(newPath)
        const file = files.get(oldNormalized)
        if (file) {
          files.delete(oldNormalized)
          files.set(newNormalized, file)
          return newPath
        }
        if (!dirs.has(oldNormalized)) throw new Error(`ENOENT: ${oldPath}`)
        const oldPrefix = `${oldNormalized}/`
        dirs.delete(oldNormalized)
        dirs.add(newNormalized)
        for (const candidate of [...dirs]) {
          if (candidate.startsWith(oldPrefix)) {
            dirs.delete(candidate)
            dirs.add(`${newNormalized}/${candidate.slice(oldPrefix.length)}`)
          }
        }
        for (const [candidate, contents] of [...files]) {
          if (candidate.startsWith(oldPrefix)) {
            files.delete(candidate)
            files.set(`${newNormalized}/${candidate.slice(oldPrefix.length)}`, contents)
          }
        }
        return newPath
      },
      mkdir: async (path: string) => { dirs.add(normalize(path)) },
    },
  }
  return { dirs, files, runtime }
}

const BASE = '/repo'
const TARGET = '/repo/.cate/worktrees/feature'
const KEY = 'owner/repo/demo:codex'
const SOURCE_SKILL = `${BASE}/.codex/skills/demo-skill`
const TARGET_SKILL = `${TARGET}/.codex/skills/demo-skill`

let fs: ReturnType<typeof makeMemoryFs>

function setText(path: string, contents: string): void {
  fs.dirs.add(parent(path))
  fs.files.set(normalize(path), Buffer.from(contents))
}

function text(path: string): string | undefined {
  return fs.files.get(normalize(path))?.toString('utf8')
}

function setCanonicalSkill(contents: string): void {
  fs.dirs.add(BASE)
  fs.dirs.add(`${BASE}/.cate`)
  fs.dirs.add(`${BASE}/.codex`)
  fs.dirs.add(`${BASE}/.codex/skills`)
  fs.dirs.add(SOURCE_SKILL)
  setText(`${SOURCE_SKILL}/SKILL.md`, contents)
  setText(`${SOURCE_SKILL}/references/guide.md`, 'guide')
  setText(`${BASE}/.cate/skills.json`, JSON.stringify({
    skills: [{
      skillId: 'owner/repo/demo',
      name: 'Demo Skill',
      targetId: 'codex',
      path: `${SOURCE_SKILL}/SKILL.md`,
      origin: 'local',
    }],
  }))
}

function clearCanonicalManifest(): void {
  setText(`${BASE}/.cate/skills.json`, JSON.stringify({ skills: [] }))
}

beforeEach(() => {
  renameFailure = null
  fs = makeMemoryFs()
  fs.dirs.add(BASE)
  fs.dirs.add(TARGET)
  resolve.mockReset().mockReturnValue(fs.runtime)
  logWarn.mockReset()
})

describe('syncWorkspaceSkills', () => {
  it('initially mirrors managed files and writes only ownership metadata', async () => {
    setCanonicalSkill('v1')

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.copied).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('v1')
    expect(text(`${TARGET_SKILL}/references/guide.md`)).toBe('guide')
    expect(text(`${TARGET}/.cate/skills.json`)).toBeUndefined()
    expect(text(`${TARGET}/.cate/skills-mirror.json`)).toContain('"contentHash"')
    expect(text(`${TARGET}/.cate/.gitignore`)).toContain('!workspace.json')
  })

  it('does not overwrite an existing target .cate/.gitignore', async () => {
    setCanonicalSkill('v1')
    setText(`${TARGET}/.cate/.gitignore`, 'custom\n')

    await syncWorkspaceSkills(BASE, TARGET)

    expect(text(`${TARGET}/.cate/.gitignore`)).toBe('custom\n')
  })

  it('updates a mirror that still matches the owned hash', async () => {
    setCanonicalSkill('v1')
    await syncWorkspaceSkills(BASE, TARGET)
    setText(`${SOURCE_SKILL}/SKILL.md`, 'v2')

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.updated).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('v2')
  })

  it('restores the previous mirror when the staged update cannot be installed', async () => {
    setCanonicalSkill('v1')
    await syncWorkspaceSkills(BASE, TARGET)
    setText(`${SOURCE_SKILL}/SKILL.md`, 'v2')
    renameFailure = (oldPath, newPath) =>
      oldPath.includes('.skills-mirror-stage-') && newPath === TARGET_SKILL

    const failed = await syncWorkspaceSkills(BASE, TARGET)

    expect(failed.warnings).toEqual([expect.stringContaining('injected rename failure')])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('v1')

    renameFailure = null
    const retried = await syncWorkspaceSkills(BASE, TARGET)
    expect(retried.updated).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('v2')
  })

  it('preserves a locally edited mirror and relinquishes ownership', async () => {
    setCanonicalSkill('v1')
    await syncWorkspaceSkills(BASE, TARGET)
    setText(`${TARGET_SKILL}/SKILL.md`, 'local edit')
    setText(`${SOURCE_SKILL}/SKILL.md`, 'v2')

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.preserved).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('local edit')
    expect(text(`${TARGET}/.cate/skills-mirror.json`)).not.toContain('owner/repo/demo')
  })

  it('removes a stale mirror only while its owned hash is unchanged', async () => {
    setCanonicalSkill('v1')
    await syncWorkspaceSkills(BASE, TARGET)
    clearCanonicalManifest()

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.removed).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBeUndefined()
  })

  it('preserves an edited mirror when its canonical entry becomes stale', async () => {
    setCanonicalSkill('v1')
    await syncWorkspaceSkills(BASE, TARGET)
    setText(`${TARGET_SKILL}/SKILL.md`, 'local edit')
    clearCanonicalManifest()

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.preserved).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('local edit')
    expect(text(`${TARGET}/.cate/skills-mirror.json`)).not.toContain('owner/repo/demo')
  })

  it('never overwrites a pre-existing unowned target skill', async () => {
    setCanonicalSkill('v1')
    fs.dirs.add(`${TARGET}/.codex`)
    fs.dirs.add(`${TARGET}/.codex/skills`)
    fs.dirs.add(TARGET_SKILL)
    setText(`${TARGET_SKILL}/SKILL.md`, 'pre-existing')

    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.preserved).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('pre-existing')
    expect(text(`${TARGET}/.cate/skills-mirror.json`)).not.toContain('owner/repo/demo')
  })

  it('is a no-op when base and target are the same locator', async () => {
    setCanonicalSkill('v1')

    const result = await syncWorkspaceSkills(`${BASE}/`, BASE)

    expect(result).toEqual({ copied: [], updated: [], removed: [], preserved: [], warnings: [] })
    expect(text(`${BASE}/.cate/skills-mirror.json`)).toBeUndefined()
  })

  it('treats Windows path casing and separators as the same locator', async () => {
    const result = await syncWorkspaceSkills('C:\\Repo\\', 'c:/repo')

    expect(result).toEqual({ copied: [], updated: [], removed: [], preserved: [], warnings: [] })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('silently skips a workspace with no canonical skills manifest', async () => {
    const result = await syncWorkspaceSkills(BASE, TARGET)

    expect(result.warnings).toEqual([])
    expect(logWarn).not.toHaveBeenCalled()
    expect(text(`${TARGET}/.cate/skills-mirror.json`)).toBeUndefined()
  })

  it('routes remote locator reads and writes through the remote runtime', async () => {
    setCanonicalSkill('remote')
    const remoteBase = 'cate-runtime://server//repo'
    const remoteTarget = 'cate-runtime://server//repo/.cate/worktrees/feature'

    const result = await syncWorkspaceSkills(remoteBase, remoteTarget)

    expect(resolve).toHaveBeenCalledWith('server')
    expect(result.copied).toEqual([KEY])
    expect(text(`${TARGET_SKILL}/SKILL.md`)).toBe('remote')
  })
})
