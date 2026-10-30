import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ANALYTICS_ENDPOINT, createAnalytics, type AnalyticsDeps } from './analytics'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function setup(overrides: Partial<AnalyticsDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-analytics-'))
  dirs.push(dir)
  const post = vi.fn(async (_body: string) => true)
  const analytics = createAnalytics({
    dir,
    enabled: true,
    context: () => ({
      install_id: 'id', app_version: '1.0.0', platform: 'darwin', arch: 'arm64', electron_version: '0',
      node_version: '0', chrome_version: '0', locale: 'en', is_packaged: true, os_release: 'test',
    }),
    post,
    installIdPreexisted: () => true,
    ...overrides,
  })
  return { analytics, post: (overrides.post as typeof post | undefined) ?? post, dir }
}

const events = (post: ReturnType<typeof vi.fn>) => post.mock.calls.map(([body]) => JSON.parse(body as string).event_name ?? 'batch')

describe('analytics', () => {
  test('never sends from an unpackaged build', async () => {
    const { analytics, post } = setup({ enabled: false })
    expect(await analytics.send('app_start')).toBe(false)
    expect(post).not.toHaveBeenCalled()
  })

  test('buffers a failed send and flushes it after the next success', async () => {
    let online = false
    const post = vi.fn(async (_body: string) => online)
    const { analytics, dir } = setup({ post })
    expect(await analytics.send('app_start')).toBe(false)
    const pending = path.join(dir, 'pending-events.jsonl')
    expect(fs.readFileSync(pending, 'utf-8')).toContain('"event_name":"app_start"')
    online = true
    await analytics.send('feature_used')
    await vi.waitFor(() => expect(fs.existsSync(pending)).toBe(false))
    expect(JSON.parse(post.mock.calls.at(-1)![0] as string)).toEqual(JSON.parse(post.mock.calls[0][0] as string))
  })

  test('a first launch reports the install, a new version the update', async () => {
    const first = setup()
    first.analytics.reportLaunch('1.0.0')
    await first.analytics.flushPending()
    expect(events(first.post)).toEqual(expect.arrayContaining(['app_install', 'app_start']))
    expect(first.analytics.hasRunBefore()).toBe(true)

    const again = setup({ dir: first.dir } as Partial<AnalyticsDeps>)
    again.analytics.reportLaunch('1.1.0')
    await again.analytics.flushPending()
    expect(events(again.post)).toContain('app_updated')
  })

  test('usage tracking clamps what the renderer sends', async () => {
    const { analytics, post } = setup()
    analytics.trackUsage('x'.repeat(100), { path: '/Users/me/secret/project/file.ts', n: 3, nested: { a: 1 } })
    await analytics.flushPending()
    const body = JSON.parse(post.mock.calls[0][0] as string)
    expect(body.data.feature).toHaveLength(64)
    expect(body.data.path.length).toBeLessThanOrEqual(48)
    expect(body.data.nested).toBeUndefined()
  })
})


test('sends the shared envelope with native context inside data and unique stable IDs', async () => {
  const { analytics, post } = setup()
  await analytics.send('feedback_submitted', { rating: 5, nested: { value: 'detail' }, install_id: 'spoof' })
  await analytics.send('app_start')
  const [first, second] = post.mock.calls.map(([body]) => JSON.parse(body))
  expect(ANALYTICS_ENDPOINT).toBe('https://analytics.cero-ai.com/api/service-events?app=cate')
  expect(Object.keys(first).sort()).toEqual(['app', 'data', 'event_id', 'event_name', 'timestamp'])
  expect(first).toMatchObject({ app: 'cate', event_name: 'feedback_submitted', data: {
    install_id: 'id', app_version: '1.0.0', platform: 'darwin', is_packaged: true,
    rating: 5, nested: { value: 'detail' },
  } })
  expect(first.event_id).toMatch(/^[a-f0-9-]{36}$/)
  expect(Number.isFinite(Date.parse(first.timestamp))).toBe(true)
  expect(second.event_id).not.toBe(first.event_id)
})

test('partial replay preserves the failed event and later events with their original IDs', async () => {
  const post = vi.fn(async (_body: string) => false)
  const { analytics, dir } = setup({ post })
  await analytics.send('app_start')
  await analytics.send('feature_used')
  const pending = path.join(dir, 'pending-events.jsonl')
  const original = fs.readFileSync(pending, 'utf-8').trim().split('\n').map(line => JSON.parse(line))
  post.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
  await analytics.flushPending()
  expect(fs.readFileSync(pending, 'utf-8').trim()).toBe(JSON.stringify(original[1]))
  post.mockResolvedValue(true)
  await analytics.flushPending()
  expect(JSON.parse(post.mock.calls.at(-1)![0])).toEqual(original[1])
  expect(fs.existsSync(pending)).toBe(false)
})

test('concurrent sends keep failed events queued and replay without batches', async () => {
  const post = vi.fn(async (_body: string) => false)
  const { analytics, dir } = setup({ post })
  await Promise.all([analytics.send('first'), analytics.send('second')])
  post.mockResolvedValue(true)
  await Promise.all([analytics.send('third'), analytics.flushPending()])
  expect(events(post)).toEqual(['first', 'second', 'third', 'first', 'second'])
  expect(post.mock.calls.every(([body]) => !('events' in JSON.parse(body)))).toBe(true)
  expect(fs.existsSync(path.join(dir, 'pending-events.jsonl'))).toBe(false)
})

test('dev builds cannot replay an existing queue, and retired records are not sent', async () => {
  const { analytics, dir } = setup({ enabled: false })
  const pending = path.join(dir, 'pending-events.jsonl')
  const oldRecord = JSON.stringify({ app: 'cate', event_name: 'app_start', props: {} })
  fs.writeFileSync(pending, oldRecord + '\n')
  await analytics.flushPending()
  expect(fs.readFileSync(pending, 'utf-8').trim()).toBe(oldRecord)
  const packaged = setup({ dir })
  await packaged.analytics.flushPending()
  expect(packaged.post).not.toHaveBeenCalled()
  expect(fs.existsSync(pending)).toBe(false)
})


test('a stalled request times out so later events can deliver and replay its stable ID', async () => {
  vi.useFakeTimers()
  try {
    const post = vi.fn(async (_body: string) => true)
    post.mockImplementationOnce(() => new Promise<boolean>(() => {}))
    const { analytics } = setup({ post })
    const stalled = analytics.send('app_start')
    const next = analytics.send('feature_used')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await stalled).toBe(false)
    expect(await next).toBe(true)
    expect(events(post)).toEqual(['app_start', 'feature_used', 'app_start'])
    expect(JSON.parse(post.mock.calls[2][0])).toEqual(JSON.parse(post.mock.calls[0][0]))
  } finally { vi.useRealTimers() }
})
