import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveClaudeTitle } from './claude'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function event(transcriptPath?: string, sessionId: string | null = 'session-1'): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'claude-code',
    kind: 'turn-end',
    sessionId,
    transcriptPath,
    raw: {},
  }
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

    await expect(resolveClaudeTitle({ event: event(file), homeDir: '/unused' }))
      .resolves.toBe('Fix terminal lifecycle')
  })

  it('uses the latest title for the active session', async () => {
    // Claude repeats ai-title records and may replace the generated title.
    const file = await transcript(
      { type: 'ai-title', aiTitle: 'Initial generated title', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 'Another session title', sessionId: 'session-2' },
      { type: 'ai-title', aiTitle: 'Updated generated title', sessionId: 'session-1' },
    )

    await expect(resolveClaudeTitle({ event: event(file), homeDir: '/unused' }))
      .resolves.toBe('Updated generated title')
  })

  it('ignores malformed, partial, and invalid title records', async () => {
    const file = await transcript(
      { type: 'ai-title', aiTitle: 'Wrong session', sessionId: 'session-2' },
      { type: 'ai-title', aiTitle: '   ', sessionId: 'session-1' },
      { type: 'ai-title', aiTitle: 42, sessionId: 'session-1' },
      '{"type":"ai-title","aiTitle":"partial',
    )

    await expect(resolveClaudeTitle({ event: event(file), homeDir: '/unused' }))
      .resolves.toBeNull()
  })

  it('returns null until Claude exposes both session identity and its transcript', async () => {
    await expect(resolveClaudeTitle({ event: event(undefined), homeDir: '/unused' }))
      .resolves.toBeNull()
    await expect(resolveClaudeTitle({ event: event('/missing/transcript.jsonl', null), homeDir: '/unused' }))
      .resolves.toBeNull()
    await expect(resolveClaudeTitle({ event: event('/missing/transcript.jsonl'), homeDir: '/unused' }))
      .resolves.toBeNull()
  })
})
