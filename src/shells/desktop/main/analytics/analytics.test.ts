import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createAnalytics, type AnalyticsDeps } from './analytics'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function setup(overrides: Partial<AnalyticsDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-analytics-'))
  dirs.push(dir)
  const post = vi.fn(async (_body: string) => true)
  const promptFeedback = vi.fn()
  const analytics = createAnalytics({
    dir,
    enabled: true,
    context: () => ({
      install_id: 'id', app_version: '1.0.0', platform: 'darwin', arch: 'arm64', electron_version: '0',
      node_version: '0', chrome_version: '0', locale: 'en', is_packaged: true, os_release: 'test',
    }),
    post,
    installIdPreexisted: () => true,
    promptFeedback,
    ...overrides,
  })
  return { analytics, post: (overrides.post as typeof post | undefined) ?? post, promptFeedback, dir }
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
    expect(JSON.parse(post.mock.calls.at(-1)![0] as string).events).toHaveLength(1)
  })

  test('a first launch reports the install without the feedback prompt; an update prompts', async () => {
    const first = setup()
    first.analytics.reportLaunch('1.0.0')
    expect(events(first.post)).toEqual(expect.arrayContaining(['app_install', 'app_start']))
    expect(first.promptFeedback).not.toHaveBeenCalled()
    expect(first.analytics.hasRunBefore()).toBe(true)

    const again = setup({ dir: first.dir } as Partial<AnalyticsDeps>)
    again.analytics.reportLaunch('1.1.0')
    expect(events(again.post)).toContain('app_updated')
    expect(again.promptFeedback).toHaveBeenCalledWith({ fromVersion: '1.0.0', toVersion: '1.1.0' })
    expect(again.analytics.feedbackPending()).toEqual({ fromVersion: '1.0.0', toVersion: '1.1.0' })
    await again.analytics.submitFeedback({ rating: 9, comment: 'good' })
    expect(again.analytics.feedbackPending()).toBeNull()
    const feedback = again.post.mock.calls.map(([b]) => JSON.parse(b as string)).find((e) => e.event_name === 'feedback_submitted')
    expect(feedback.props).toMatchObject({ rating: 5, comment: 'good' })
  })

  test('usage tracking clamps what the renderer sends', () => {
    const { analytics, post } = setup()
    analytics.trackUsage('x'.repeat(100), { path: '/Users/me/secret/project/file.ts', n: 3, nested: { a: 1 } })
    const body = JSON.parse(post.mock.calls[0][0] as string)
    expect(body.props.feature).toHaveLength(64)
    expect(body.props.path.length).toBeLessThanOrEqual(48)
    expect(body.props.nested).toBeUndefined()
  })
})
