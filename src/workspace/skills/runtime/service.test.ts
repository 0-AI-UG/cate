import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRpcError, RpcError } from '@kernel/rpc/contract'
import type { SkillEntry } from '../contract'
import { createSkillsRuntime, type SkillsRuntime } from './service'
import { TEST_TARGETS } from './testSupport'

const BUNDLED = path.join(process.cwd(), 'skills')

let tmp: string
let root: string
let dataDir: string
let trusted: boolean
let checkouts: string[]
let service: SkillsRuntime

// A GitHub stand-in serving one repo with one skill.
const fakeFetch = async (url: string): Promise<Response> => {
  if (url.endsWith('skills-index.json')) return new Response('{"skills":[]}', { status: 200 })
  if (url.includes('/git/trees/')) {
    return Response.json({ tree: [{ path: 'skills/demo/SKILL.md', type: 'blob' }, { path: 'skills/demo/refs/guide.md', type: 'blob' }], truncated: false })
  }
  if (url.startsWith('https://api.github.com/repos/')) return Response.json({ default_branch: 'main', stargazers_count: 1, pushed_at: '' })
  if (url.endsWith('/skills/demo/SKILL.md')) return new Response('---\nname: demo\ndescription: A demo\n---\nbody')
  if (url.endsWith('/skills/demo/refs/guide.md')) return new Response('guide')
  return new Response('missing', { status: 404 })
}

const demoEntry: SkillEntry = {
  id: 'owner-repo/demo', name: 'demo', description: 'A demo', tags: [], format: 'skill-md',
  source: { repo: 'owner/repo', ref: 'main', path: 'skills/demo' }, provenance: 'curated', sourceId: 'owner-repo',
}

const read = (rel: string) => fs.readFile(path.join(root, rel), 'utf8')
const exists = (rel: string) => fs.stat(path.join(root, rel)).then(() => true, () => false)

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-skills-service-'))
  root = path.join(tmp, 'repo')
  dataDir = path.join(tmp, 'data')
  await fs.mkdir(root)
  trusted = true
  checkouts = []
  service = createSkillsRuntime({
    root,
    dataPaths: { skillSources: path.join(dataDir, 'skills/sources.json') },
    trust: {
      isTrusted: () => trusted,
      requireTrusted: () => { if (!trusted) throw new RpcError('untrusted') },
    },
    targets: TEST_TARGETS,
    bundledSkillsDir: BUNDLED,
    fetch: fakeFetch,
    listCheckouts: async () => checkouts,
  })
})

afterEach(async () => {
  await service.dispose()
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('skills runtime', () => {
  it('installs into the workspace agent dirs and records the manifest', async () => {
    const result = await service.install(demoEntry, 'claude-code')
    await service.install(demoEntry, 'codex')

    expect(await read('.claude/skills/demo/SKILL.md')).toContain('body')
    expect(await read('.claude/skills/demo/refs/guide.md')).toBe('guide')
    expect(await read('.codex/skills/demo/SKILL.md')).toContain('name: demo')
    expect(result.installed.path).toBe(path.join(root, '.claude/skills/demo/SKILL.md'))
    const manifest = JSON.parse(await read('.cate/skills.json'))
    expect(manifest.skills.map((s: { skillId: string; targetId: string }) => `${s.skillId}:${s.targetId}`))
      .toEqual(['owner-repo/demo:claude-code', 'owner-repo/demo:codex'])
    expect(await service.listInstalled()).toHaveLength(2)

    await service.uninstall('owner-repo/demo', 'codex')
    expect(await exists('.codex/skills/demo')).toBe(false)
    expect((await service.listInstalled()).map((s) => s.targetId)).toEqual(['claude-code'])
  })

  it('falls back to another agent install when the source is unreachable', async () => {
    await service.install(demoEntry, 'claude-code')
    const offline = { ...demoEntry, source: { ...demoEntry.source, repo: 'gone/repo', path: 'nope' } }
    const result = await service.install(offline, 'grok')
    expect(await read('.grok/skills/demo/SKILL.md')).toContain('body')
    expect(result.warnings).toContain('Latest source unavailable; installed the existing offline copy.')
  })

  it('refuses an unknown target', async () => {
    await expect(service.install(demoEntry, 'antigravity')).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })

  it('lists the bundled skills as a source and installs them from the runtime dir', async () => {
    const index = await service.index()
    const bundled = index.filter((e) => e.provenance === 'bundled')
    expect(bundled.map((e) => e.id)).toEqual(['cate/cate-cli', 'cate/cate-theme'])
    expect(index.filter((e) => e.id === 'cate/cate-cli')).toHaveLength(1)

    const theme = bundled.find((e) => e.id === 'cate/cate-theme')!
    await service.install(theme, 'claude-code')
    expect(await read('.claude/skills/cate-theme/theme.schema.json')).toBe(
      await fs.readFile(path.join(BUNDLED, 'cate-theme/theme.schema.json'), 'utf8'),
    )
    expect(await read('.claude/skills/cate-theme/SKILL.md')).toContain('name: cate-theme')
  })

  it('seeds bundled skills into targets whose tool dir exists', async () => {
    await fs.mkdir(path.join(root, '.codex'))
    await service.seedBundled()
    expect(await read('.codex/skills/cate-cli/SKILL.md')).toContain('name: cate-cli')
    expect(await read('.codex/skills/cate-theme/SKILL.md')).toContain('name: cate-theme')
    expect(await exists('.claude')).toBe(false)
    const manifest = JSON.parse(await read('.cate/skills.json'))
    expect(manifest.seeded).toHaveLength(2)

    await fs.writeFile(path.join(root, '.codex/skills/cate-cli/SKILL.md'), 'edited')
    expect(await service.reinstallBundled('cate-cli')).toEqual({ installedTargets: 1, warnings: [] })
    expect(await read('.codex/skills/cate-cli/SKILL.md')).toContain('name: cate-cli')
  })

  it('mirrors installs into known worktree checkouts only', async () => {
    const checkout = path.join(root, '.cate/worktrees/feature')
    await fs.mkdir(checkout, { recursive: true })
    checkouts = [checkout]
    await service.install(demoEntry, 'codex')
    expect(await fs.readFile(path.join(checkout, '.codex/skills/demo/SKILL.md'), 'utf8')).toContain('body')
    expect(await fs.readFile(path.join(checkout, '.cate/skills-mirror.json'), 'utf8')).toContain('owner-repo/demo')
    await expect(service.syncCheckout(path.join(tmp, 'elsewhere'))).rejects.toSatisfy((e) => isRpcError(e, 'rejected'))
  })

  it('refuses to apply anything while the workspace is untrusted', async () => {
    trusted = false
    await fs.mkdir(path.join(root, '.claude'))
    const untrusted = (e: unknown) => isRpcError(e, 'untrusted')
    await expect(service.install(demoEntry, 'claude-code')).rejects.toSatisfy(untrusted)
    await expect(service.uninstall('owner-repo/demo', 'claude-code')).rejects.toSatisfy(untrusted)
    await expect(service.reinstallBundled('cate-cli')).rejects.toSatisfy(untrusted)
    await expect(service.syncCheckout(root)).rejects.toSatisfy(untrusted)
    await service.seedBundled()
    expect(await fs.readdir(path.join(root, '.claude'))).toEqual([])
    expect(await exists('.cate')).toBe(false)
  })

  it('keeps workspace skill sources in the data dir', async () => {
    const source = service.addSource('https://github.com/Foo/Bar.git', { path: 'skills' })
    expect(source).toMatchObject({ repo: 'Foo/Bar', path: 'skills' })
    expect(service.addSource('Foo/Bar', { path: 'skills' })).toEqual(source)
    expect(() => service.addSource('nope')).toThrow(RpcError)
    await service.dispose()
    const file = JSON.parse(await fs.readFile(path.join(dataDir, 'skills/sources.json'), 'utf8'))
    expect(file.sources).toEqual([source])
    service.removeSource(source.id)
    expect(service.listSources()).toEqual([])
  })
})
