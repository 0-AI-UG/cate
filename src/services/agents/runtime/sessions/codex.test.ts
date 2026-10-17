import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionLocator } from './types'
import { codexSessionStore } from './codex'

let homeDir = ''

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-codex-title-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

function session(sessionId: string): AgentSessionLocator {
  return { agentId: 'codex', sessionId }
}

async function writeIndex(lines: string[]): Promise<void> {
  const codexDir = path.join(homeDir, '.codex')
  await mkdir(codexDir)
  await writeFile(path.join(codexDir, 'session_index.jsonl'), `${lines.join('\n')}\n`)
}

describe('Codex session title', () => {
  it('reads Codex 0.153 SessionIndexEntry.thread_name for the session id', async () => {
    // Pinned from Codex 0.153 rollout/src/session_index.rs: one JSON object per
    // line with exactly the join key, native chat title, and update timestamp.
    await writeIndex([
      JSON.stringify({ id: 'other-session', thread_name: 'Other chat', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Automatic terminal titles', updated_at: '2026-09-03T10:01:00Z' }),
    ])

    await expect(codexSessionStore.title({ session: session('session-1'), homeDir }))
      .resolves.toBe('Automatic terminal titles')
  })

  it('uses the last appended entry when Codex renames a thread', async () => {
    await writeIndex([
      JSON.stringify({ id: 'session-1', thread_name: 'Original title', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Renamed title', updated_at: '2026-09-03T10:05:00Z' }),
    ])

    await expect(codexSessionStore.title({ session: session('session-1'), homeDir }))
      .resolves.toBe('Renamed title')
  })

  it('ignores malformed and incomplete rows without losing an earlier title', async () => {
    await writeIndex([
      '{not json}',
      JSON.stringify({ id: 'session-1', title: 'Wrong schema', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Complete title', updated_at: '2026-09-03T10:01:00Z' }),
      '{"id":"session-1","thread_name":',
    ])

    await expect(codexSessionStore.title({ session: session('session-1'), homeDir }))
      .resolves.toBe('Complete title')
  })

  it('returns null when the session or index is unavailable', async () => {
    await expect(codexSessionStore.title({ session: session(''), homeDir })).resolves.toBeNull()
    await expect(codexSessionStore.title({ session: session('missing'), homeDir })).resolves.toBeNull()
  })
})

describe('Codex session conversation', () => {
  const line = (timestamp: string, type: string, payload: unknown) => JSON.stringify({ timestamp, type, payload })

  async function writeRollout(relativeDir: string, sessionId: string, lines: string[]): Promise<string> {
    const dir = path.join(homeDir, '.codex', relativeDir)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `rollout-2026-09-27T20-09-29-${sessionId}.jsonl`)
    await writeFile(file, `${lines.join('\n')}\n`)
    return file
  }

  it('reads paginated UI items and ignores the injected model channel', async () => {
    // Pinned from Codex 0.157 rollouts: the UI channel (`event_msg`) carries only
    // what the user saw; `response_item` repeats it with AGENTS.md context.
    const file = await writeRollout('sessions/2026/09/27', 'session-1', [
      line('2026-09-27T18:09:29.000Z', 'session_meta', { id: 'session-1', history_mode: 'paginated' }),
      line('2026-09-27T18:09:29.100Z', 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] }),
      line('2026-09-27T18:09:29.502Z', 'event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'Start the spec', text_elements: [] }] } }),
      line('2026-09-27T18:09:30.000Z', 'event_msg', { type: 'item_completed', item: { type: 'Reasoning', content: [] } }),
      line('2026-09-27T18:09:31.000Z', 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', command: 'ls' } }),
      line('2026-09-27T18:09:33.977Z', 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Looking at the runtime.' }], phase: 'commentary' } }),
      line('2026-09-27T18:09:40.000Z', 'event_msg', { type: 'item_completed', item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'Done.' }], phase: 'final_answer' } }),
      line('2026-09-27T18:09:41.000Z', 'event_msg', { type: 'task_complete' }),
      '{"timestamp":"2026-09-27T18:09:42.000Z","type":"event_msg","payload":{"type":"item_comp',
    ])

    await expect(codexSessionStore.conversation({ session: { agentId: 'codex', sessionId: 'session-1', transcriptPath: file }, homeDir }))
      .resolves.toEqual([
        { role: 'user', text: 'Start the spec', createdAt: '2026-09-27T18:09:29.502Z' },
        { role: 'assistant', text: 'Looking at the runtime.', createdAt: '2026-09-27T18:09:33.977Z' },
        { role: 'assistant', text: 'Done.', createdAt: '2026-09-27T18:09:40.000Z' },
      ])
  })

  it('reads legacy user_message / agent_message rollouts found by session id', async () => {
    await writeRollout('sessions/2026/08/01', 'legacy-1', [
      line('2026-08-01T10:00:00.000Z', 'event_msg', { type: 'user_message', message: 'Old prompt', images: [] }),
      line('2026-08-01T10:00:05.000Z', 'event_msg', { type: 'agent_reasoning', text: 'thinking' }),
      line('2026-08-01T10:00:09.000Z', 'event_msg', { type: 'agent_message', message: 'Old answer', phase: 'final_answer' }),
    ])

    await expect(codexSessionStore.conversation({ session: { agentId: 'codex', sessionId: 'legacy-1' }, homeDir }))
      .resolves.toEqual([
        { role: 'user', text: 'Old prompt', createdAt: '2026-08-01T10:00:00.000Z' },
        { role: 'assistant', text: 'Old answer', createdAt: '2026-08-01T10:00:09.000Z' },
      ])
  })

  it('falls back to archived rollouts and returns null for unknown sessions', async () => {
    await writeRollout('archived_sessions', 'archived-1', [
      line('2026-07-01T10:00:00.000Z', 'event_msg', { type: 'user_message', message: 'Archived prompt' }),
    ])

    await expect(codexSessionStore.conversation({ session: { agentId: 'codex', sessionId: 'archived-1' }, homeDir }))
      .resolves.toEqual([{ role: 'user', text: 'Archived prompt', createdAt: '2026-07-01T10:00:00.000Z' }])
    await expect(codexSessionStore.conversation({ session: { agentId: 'codex', sessionId: 'missing' }, homeDir }))
      .resolves.toBeNull()
  })
})
