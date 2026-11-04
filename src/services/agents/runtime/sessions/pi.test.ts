import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { piSessionStore, piUsageParser } from './pi'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

test('reads only the active conversation branch and the latest native title, ignoring tool/thinking/context entries', async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'cate-pi-store-'))
  const bucket = path.join(directory, '.pi/agent/sessions/--repo--')
  await mkdir(bucket, { recursive: true })
  const file = path.join(bucket, 'timestamp_session-1.jsonl')
  const entries = [
    { type: 'session', id: 'session-1', cwd: '/repo' },
    { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'First prompt', timestamp: 1790000000000 } },
    { type: 'message', id: 'a', parentId: 'u', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'Reply' }] } },
    { type: 'message', id: 'abandoned', parentId: 'a', message: { role: 'user', content: 'Abandoned' } },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: [{ type: 'text', text: 'Active branch' }, { type: 'image', data: 'private' }] } },
    { type: 'message', id: 'tool', parentId: 'b', message: { role: 'toolResult', content: 'Tool result' } },
    { type: 'session_info', id: 'name', parentId: 'tool', name: 'Renamed' },
  ]
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n{partial')
  const context = { homeDir: directory, session: { agentId: 'pi' as const, sessionId: 'session-1', cwd: '/repo' } }
  expect(await piSessionStore.title(context)).toBe('Renamed')
  expect((await piSessionStore.conversation(context))?.map((message) => message.text)).toEqual(['First prompt', 'Reply', 'Active branch'])
  expect((await piSessionStore.conversation({ ...context, session: { ...context.session, leafId: 'a' } }))?.map((message) => message.text)).toEqual(['First prompt', 'Reply'])
  expect(await piSessionStore.conversation({ ...context, session: { ...context.session, leafId: null } })).toEqual([])
  expect(await piSessionStore.files!(context)).toEqual([file])
  expect(await piSessionStore.conversation({ ...context, session: { ...context.session, sessionId: '../escape' } })).toBeNull()
})

test('resumes incremental usage accounting and includes compaction and standalone usage without subtracting cached input twice', () => {
  const parser = piUsageParser()!
  const line = (entry: unknown) => parser.line(JSON.stringify(entry))
  line({ type: 'session', id: 'session-1', cwd: '/repo' })
  line({ type: 'model_change', modelId: 'provider/model' })
  const usage = { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, cost: { total: 0.02 } }
  const timestamp = '2026-10-30T10:00:00Z'
  const entry = { type: 'message', id: 'a', timestamp, message: { role: 'assistant', model: 'provider/model', usage } }
  const [record] = line(entry)
  expect(record).toMatchObject({ sessionId: 'session-1', cwd: '/repo', model: 'provider/model', reportedCostUsd: 0.02,
    totals: { uncachedInputTokens: 100, outputTokens: 20, cachedInputTokens: 50, cacheCreationTokens: 10 } })
  line({ type: 'session', id: 'forked-session', cwd: '/repo' })
  expect(line(entry)[0].dedupeKey, 'copied fork entries must not be charged twice').toBe(record.dedupeKey)
  line({ type: 'session', id: 'session-1', cwd: '/repo' })
  const resumed = piUsageParser(parser.state())!
  for (const type of ['compaction', 'branch_summary', 'usage']) expect(resumed.line(JSON.stringify({ type, id: type, timestamp, usage }))[0]).toMatchObject({ sessionId: 'session-1', cwd: '/repo', model: 'provider/model', reportedCostUsd: 0.02 })
  expect(resumed.line('{partial')).toEqual([])
  expect(piUsageParser({ version: 999 })).toBeNull()
})
