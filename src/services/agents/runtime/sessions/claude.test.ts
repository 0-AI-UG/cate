import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentSessionLocator } from './types'
import { claudeSessionStore, claudeUsageLimits, claudeUsageRecord } from './claude'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function session(transcriptPath?: string, sessionId = 'session-1'): AgentSessionLocator {
  return { agentId: 'claude-code', sessionId, transcriptPath }
}

async function transcript(...records: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cate-claude-title-'))
  tempDirs.push(dir)
  const file = join(dir, 'session-1.jsonl')
  await writeFile(file, `${records.map((record) =>
    typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`)
  return file
}

describe('Claude Code title resolver', () => {
  it('reads the native ai-title record from the hook-provided transcript', async () => {
    // Pinned against Claude Code 2.1.222: the session picker title is a
    // top-level JSONL record, not a field nested in a user/assistant message.
    const file = await transcript(
      { type: 'user', sessionId: 'session-1', message: { content: 'unrelated prompt' } },
      { type: 'ai-title', aiTitle: 'Fix terminal lifecycle', sessionId: 'session-1' },
      { type: 'last-prompt', lastPrompt: 'unrelated prompt', sessionId: 'session-1' },
    )

    await expect(claudeSessionStore.title({ session: session(file), homeDir: '/unused' }))
      .resolves.toBe('Fix terminal lifecycle')
  })

  it('uses the latest title for the active session', async () => {
    // Claude repeats ai-title records and may replace the generated title.
    const file = await transcript(
      { type: 'ai-title', aiTitle: 'Initial generated title', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Another session title', sessionId: 'session-2' },
      { type: 'ai-title', aiTitle: 'Updated generated title', sessionId: 'session-1' },
    )

    await expect(claudeSessionStore.title({ session: session(file), homeDir: '/unused' }))
      .resolves.toBe('Updated generated title')
  })

  it('ignores malformed, partial, and invalid title records', async () => {
    const file = await transcript(
      { type: 'ai-title', aiTitle: 'Wrong session', sessionId: 'session-2' },
      { type: 'ai-title', aiTitle: '   ', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 42, sessionId: 'session-1' },
      '{"type":"ai-title","aiTitle":"partial',
    )

    await expect(claudeSessionStore.title({ session: session(file), homeDir: '/unused' }))
      .resolves.toBeNull()
  })

  it('returns null until Claude exposes both session identity and its transcript', async () => {
    await expect(claudeSessionStore.title({ session: session(undefined), homeDir: '/unused' }))
      .resolves.toBeNull()
    await expect(claudeSessionStore.title({ session: session('/missing/transcript.jsonl', ''), homeDir: '/unused' }))
      .resolves.toBeNull()
    await expect(claudeSessionStore.title({ session: session('/missing/transcript.jsonl'), homeDir: '/unused' }))
      .resolves.toBeNull()
  })
})

describe('Claude Code session conversation', () => {
  const assistant = (id: string, blocks: unknown[], timestamp = '2026-09-28T09:22:36.764Z') => ({
    type: 'assistant', isSidechain: false, timestamp, message: { id, role: 'assistant', content: blocks },
  })

  it('keeps typed prompts and merges per-block assistant records by message id', async () => {
    const file = await transcript(
      { type: 'mode', mode: 'default' },
      { type: 'user', timestamp: '2026-09-28T09:22:02.089Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: 'Check the last commit' } },
      assistant('msg_1', [{ type: 'thinking', thinking: 'hmm' }]),
      assistant('msg_1', [{ type: 'text', text: 'Looking at it.' }]),
      assistant('msg_1', [{ type: 'tool_use', name: 'Bash', input: {} }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'commit abc' }] }, toolUseResult: {} },
      assistant('msg_2', [{ type: 'text', text: 'It fixes T3 startup.' }], '2026-09-28T09:23:00.000Z'),
      assistant('msg_2', [{ type: 'text', text: 'Nothing else changed.' }], '2026-09-28T09:23:01.000Z'),
      { type: 'ai-title', aiTitle: 'Commit check', sessionId: 'session-1' },
      '{"type":"assistant","message":{"id":"msg_3","content":[{"type":"text","text":"partial',
    )

    await expect(claudeSessionStore.conversation({ session: session(file), homeDir: '/unused' })).resolves.toEqual([
      { role: 'user', text: 'Check the last commit', createdAt: '2026-09-28T09:22:02.089Z' },
      { role: 'assistant', text: 'Looking at it.', createdAt: '2026-09-28T09:22:36.764Z' },
      { role: 'assistant', text: 'It fixes T3 startup.\n\nNothing else changed.', createdAt: '2026-09-28T09:23:00.000Z' },
    ])
  })

  it('skips injected, notification, command-echo, sidechain, compaction, and error records', async () => {
    const file = await transcript(
      { type: 'user', isMeta: true, message: { content: 'Base directory for this skill' } },
      { type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system', message: { content: '<task-notification>' } },
      { type: 'user', origin: { kind: 'peer' }, message: { content: 'Peer report' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } },
      { type: 'user', isCompactSummary: true, message: { content: 'Summary of earlier work' } },
      { type: 'user', isSidechain: true, message: { content: 'Subagent prompt' } },
      { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'assistant', isApiErrorMessage: true, message: { id: 'err', content: [{ type: 'text', text: 'API Error' }] } },
      { type: 'user', promptSource: 'sdk', message: { content: [{ type: 'text', text: 'Real prompt' }, { type: 'image', source: {} }] } },
    )

    await expect(claudeSessionStore.conversation({ session: session(file), homeDir: '/unused' }))
      .resolves.toEqual([{ role: 'user', text: 'Real prompt', createdAt: undefined }])
  })

  it('locates the transcript from cwd and session id when the hook path is absent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'cate-claude-home-'))
    tempDirs.push(homeDir)
    const projectDir = join(homeDir, '.claude', 'projects', '-Users-me-my-project')
    await mkdir(projectDir, { recursive: true })
    await writeFile(join(projectDir, 'session-1.jsonl'), `${JSON.stringify({ type: 'user', message: { content: 'Hello' } })}\n`)

    await expect(claudeSessionStore.conversation({
      session: { agentId: 'claude-code', sessionId: 'session-1', cwd: '/Users/me/my_project' },
      homeDir,
    })).resolves.toEqual([{ role: 'user', text: 'Hello', createdAt: undefined }])
    // A long or unexpected slug still resolves through the project-dir scan.
    await expect(claudeSessionStore.conversation({
      session: { agentId: 'claude-code', sessionId: 'session-1', cwd: `/${'x'.repeat(300)}` },
      homeDir,
    })).resolves.toHaveLength(1)
    await expect(claudeSessionStore.conversation({
      session: { agentId: 'claude-code', sessionId: 'missing', cwd: '/Users/me/my_project' },
      homeDir,
    })).resolves.toBeNull()
  })
})

describe('Claude Code usage', () => {
  it('reads an assistant record with its cwd and the message/request dedupe key', () => {
    const record = claudeUsageRecord(JSON.stringify({
      type: 'assistant', timestamp: '2026-10-01T10:00:00Z', sessionId: 's1', requestId: 'r1', cwd: '/repo',
      message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } },
    }))
    expect(record).toEqual({
      timestampMs: Date.parse('2026-10-01T10:00:00Z'), model: 'claude-sonnet-4-5', sessionId: 's1', cwd: '/repo',
      totals: { uncachedInputTokens: 10, cachedInputTokens: 100, cacheCreationTokens: 7, outputTokens: 5, reasoningTokens: 0 },
      reportedCostUsd: null, dedupeKey: 'm1:r1',
    })
    expect(claudeUsageRecord(JSON.stringify({ type: 'user', message: { usage: {} } }))).toBeNull()
  })

  it('maps a get_usage answer to limit windows', () => {
    const limits = claudeUsageLimits({
      subscription_type: 'max', rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 5, resets_at: '2026-10-18T00:00:00Z' }, seven_day: { utilization: 10, resets_at: null }, model_scoped: [{ display_name: 'Fable', utilization: 0 }] },
    }, { email: 'a@b.c' }, '2026-10-17T00:00:00.000Z')
    expect(limits).toMatchObject({ agent: 'claude-code', email: 'a@b.c', plan: 'Claude Max Subscription' })
    expect(limits.windows.map((w) => [w.id, w.kind, w.usedPercent])).toEqual([['five_hour', 'session', 5], ['seven_day', 'weekly', 10], ['seven_day_fable', 'weekly', 0]])
    expect(claudeUsageLimits({ rate_limits_available: false }, undefined, 'now').unavailable?.reason).toBe('unsupported')
  })
})
