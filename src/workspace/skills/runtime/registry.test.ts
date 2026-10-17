import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillEntry, SkillSource } from '../contract'
import type { Logger } from '@kernel/log/contract'

const crawl = vi.hoisted(() => ({ listSkillsInRepo: vi.fn(), rawText: vi.fn(), fetchWithTimeout: vi.fn() }))
vi.mock('./githubCrawl', () => crawl)

import { createSkillsRegistry } from './registry'

const sourceState = { sources: [] as SkillSource[], token: undefined as string | undefined }
const logger = { info: vi.fn(), warn: vi.fn() }
const fetchMock = vi.fn()
let registry: ReturnType<typeof createSkillsRegistry>
let getMergedIndex: () => Promise<SkillEntry[]>
let getPreview: (entry: SkillEntry) => Promise<string>
let refresh: () => void

function skill(id: string, repo: string, path: string, provenance: 'curated' | 'user'): SkillEntry {
  return {
    id,
    name: id,
    description: id,
    tags: [],
    format: 'skill-md',
    source: { repo, ref: 'main', path },
    provenance,
    sourceId: repo,
  }
}

beforeEach(() => {
  registry = createSkillsRegistry({
    fetch: fetchMock,
    githubToken: async () => sourceState.token,
    sources: () => sourceState.sources,
    bundled: async () => [],
    log: logger as unknown as Logger,
  })
  ;({ getMergedIndex, getPreview, refresh } = registry)
  crawl.fetchWithTimeout.mockReset().mockImplementation((f: typeof fetch, url: string) => f(url))
  sourceState.sources = [{ id: 'user-source', repo: 'user/repo' }]
  sourceState.token = 'github-token'
  crawl.listSkillsInRepo.mockReset().mockResolvedValue([])
  crawl.rawText.mockReset()
  logger.info.mockReset()
  logger.warn.mockReset()
  fetchMock.mockReset()
})

describe('skillsRegistry cache and merge behavior', () => {
  it('deduplicates repo paths case-insensitively with curated metadata winning', async () => {
    const curated = skill('curated-copy', 'Owner/Repo', 'skills/demo', 'curated')
    const duplicate = skill('user-copy', 'owner/repo', 'skills/demo', 'user')
    const userOnly = skill('user-only', 'user/repo', 'skills/only', 'user')
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ skills: [curated] }) } as Response)
    crawl.listSkillsInRepo.mockResolvedValue([duplicate, userOnly])

    const first = await getMergedIndex()
    const second = await getMergedIndex()

    expect(first).toEqual([expect.objectContaining({ id: 'curated-copy', provenance: 'curated' }), userOnly])
    expect(second).toEqual(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(crawl.listSkillsInRepo).toHaveBeenCalledTimes(1)
    expect(crawl.listSkillsInRepo).toHaveBeenCalledWith(sourceState.sources[0], { fetch: fetchMock, token: 'github-token' })
  })

  it('refresh invalidates both curated and user caches', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ skills: [] }) } as Response)

    await getMergedIndex()
    await getMergedIndex()
    refresh()
    await getMergedIndex()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(crawl.listSkillsInRepo).toHaveBeenCalledTimes(2)
  })

  it('falls back to the bundled curated index and isolates a failed user source', async () => {
    sourceState.sources = [
      { id: 'broken', repo: 'broken/repo' },
      { id: 'working', repo: 'working/repo' },
    ]
    fetchMock.mockRejectedValue(new Error('offline'))
    const live = skill('live', 'working/repo', 'skills/live', 'user')
    crawl.listSkillsInRepo.mockImplementation(async (source: SkillSource) => {
      if (source.id === 'broken') throw new Error('rate limited')
      return [live]
    })

    const merged = await getMergedIndex()

    expect(merged).toContainEqual(live)
    expect(merged.some((entry) => entry.provenance === 'curated')).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('curated index unavailable'),
      expect.stringContaining('offline'),
    )
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('live crawl failed'),
      'broken/repo',
      expect.any(Error),
    )
  })
})

it('refreshes user sources on sign-in, account switch, and sign-out', async () => {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ skills: [] }) } as Response)
  for (const token of [undefined, 'first-account', 'second-account', undefined]) {
    sourceState.token = token
    await getMergedIndex()
    expect(crawl.listSkillsInRepo).toHaveBeenLastCalledWith(sourceState.sources[0], { fetch: fetchMock, token })
  }
  expect(crawl.listSkillsInRepo).toHaveBeenCalledTimes(4)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

it('uses current GitHub credentials for previews, including signed-out access', async () => {
  const entry = skill('demo', 'owner/repo', 'skills/demo', 'user')
  for (const token of ['account-token', undefined]) {
    sourceState.token = token
    await getPreview(entry)
    expect(crawl.rawText).toHaveBeenLastCalledWith('owner/repo', 'main', 'skills/demo/SKILL.md', { fetch: fetchMock, token })
  }
})

it('lists bundled skills first and drops the curated copy of the same skill', async () => {
  const bundledEntry = { ...skill('cate/cate-cli', '0-AI-UG/cate', 'skills/cate-cli', 'user'), provenance: 'bundled' as const }
  const curatedCopy = skill('curated-cate-cli', '0-AI-UG/cate', 'skills/cate-cli', 'curated')
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ skills: [curatedCopy] }) } as Response)
  const withBundled = createSkillsRegistry({
    fetch: fetchMock, githubToken: async () => undefined, sources: () => [],
    bundled: async () => [bundledEntry], log: logger as unknown as Logger,
  })
  expect(await withBundled.getMergedIndex()).toEqual([bundledEntry])
})
