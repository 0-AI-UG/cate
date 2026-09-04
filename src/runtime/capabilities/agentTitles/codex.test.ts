import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveCodexTitle } from './codex'

let homeDir = ''

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-codex-title-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

function event(sessionId: string | null): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'codex',
    kind: 'turn-end',
    sessionId,
    raw: {},
  }
}

async function writeIndex(lines: string[]): Promise<void> {
  const codexDir = path.join(homeDir, '.codex')
  await mkdir(codexDir)
  await writeFile(path.join(codexDir, 'session_index.jsonl'), `${lines.join('\n')}\n`)
}

describe('resolveCodexTitle', () => {
  it('reads Codex 0.153 SessionIndexEntry.thread_name for the session id', async () => {
    // Pinned from Codex 0.153 rollout/src/session_index.rs: one JSON object per
    // line with exactly the join key, native chat title, and update timestamp.
    await writeIndex([
      JSON.stringify({ id: 'other-session', thread_name: 'Other chat', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Automatic terminal titles', updated_at: '2026-09-03T10:01:00Z' }),
    ])

    await expect(resolveCodexTitle({ event: event('session-1'), homeDir }))
      .resolves.toBe('Automatic terminal titles')
  })

  it('uses the last appended entry when Codex renames a thread', async () => {
    await writeIndex([
      JSON.stringify({ id: 'session-1', thread_name: 'Original title', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Renamed title', updated_at: '2026-09-03T10:05:00Z' }),
    ])

    await expect(resolveCodexTitle({ event: event('session-1'), homeDir }))
      .resolves.toBe('Renamed title')
  })

  it('ignores malformed and incomplete rows without losing an earlier title', async () => {
    await writeIndex([
      '{not json}',
      JSON.stringify({ id: 'session-1', title: 'Wrong schema', updated_at: '2026-09-03T10:00:00Z' }),
      JSON.stringify({ id: 'session-1', thread_name: 'Complete title', updated_at: '2026-09-03T10:01:00Z' }),
      '{"id":"session-1","thread_name":',
    ])

    await expect(resolveCodexTitle({ event: event('session-1'), homeDir }))
      .resolves.toBe('Complete title')
  })

  it('returns null when the session or index is unavailable', async () => {
    await expect(resolveCodexTitle({ event: event(null), homeDir })).resolves.toBeNull()
    await expect(resolveCodexTitle({ event: event('missing'), homeDir })).resolves.toBeNull()
  })
})
