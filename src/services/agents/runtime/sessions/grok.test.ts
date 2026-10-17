import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionLocator } from './types'
import { grokSessionStore } from './grok'

let homeDir = ''
let transcriptPath = ''

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-grok-title-'))
  const sessionDir = path.join(homeDir, '.grok', 'sessions', '%2Fworkspace', 'session-1')
  await mkdir(sessionDir, { recursive: true })
  transcriptPath = path.join(sessionDir, 'updates.jsonl')
  await writeFile(transcriptPath, '')
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

function session(overrides: Partial<AgentSessionLocator> = {}): AgentSessionLocator {
  return { agentId: 'grok', sessionId: 'session-1', transcriptPath, ...overrides }
}

async function writeSummary(summary: unknown): Promise<void> {
  await writeFile(path.join(path.dirname(transcriptPath), 'summary.json'), JSON.stringify(summary))
}

describe('Grok session title', () => {
  it('reads Grok 0.2.106 generated_title beside the updates transcript', async () => {
    // Pinned from Grok's documented summary.json schema. `session_summary` is
    // not the title shown by the welcome screen and `/resume` picker.
    await writeSummary({
      info: { session_id: 'session-1', cwd: '/workspace' },
      session_summary: 'A longer summary of the conversation',
      generated_title: 'Implement automatic terminal titles',
      title_is_manual: false,
      created_at: '2026-09-03T10:00:00Z',
      updated_at: '2026-09-03T10:01:00Z',
    })

    await expect(grokSessionStore.title({ session: session(), homeDir }))
      .resolves.toBe('Implement automatic terminal titles')
  })

  it('uses the current generated_title after /rename overwrites summary.json', async () => {
    await writeSummary({
      generated_title: 'Generated title',
      title_is_manual: false,
    })
    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBe('Generated title')

    // Grok keeps manual and generated titles in the same field. The boolean
    // records provenance; it does not select a second title field.
    await writeSummary({
      generated_title: 'Manually renamed title',
      title_is_manual: true,
    })
    await expect(grokSessionStore.title({ session: session(), homeDir }))
      .resolves.toBe('Manually renamed title')
  })

  it('does not substitute session_summary while a native title is unavailable', async () => {
    await writeSummary({
      session_summary: 'This is metadata, not Grok\'s picker title',
      generated_title: null,
      title_is_manual: false,
    })
    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await writeSummary({ generated_title: '   ', title_is_manual: true })
    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()
  })

  it('returns null for missing identity, transcript, or valid summary metadata', async () => {
    await expect(grokSessionStore.title({
      session: session({ sessionId: '' }),
      homeDir,
    })).resolves.toBeNull()
    await expect(grokSessionStore.title({
      session: session({ transcriptPath: undefined }),
      homeDir,
    })).resolves.toBeNull()

    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()
    await writeFile(path.join(path.dirname(transcriptPath), 'summary.json'), '{partial')
    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await writeSummary({ generated_title: 42 })
    await expect(grokSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()
  })
})

describe('Grok session conversation', () => {
  const update = (kind: string, content: unknown, meta: Record<string, unknown> = {}, timestamp = 1788790183) => JSON.stringify({
    timestamp,
    method: 'session/update',
    params: { sessionId: 'session-1', update: { sessionUpdate: kind, content }, _meta: meta },
  })
  const text = (value: string) => ({ type: 'text', text: value })

  it('concatenates streamed agent chunks per prompt and skips thoughts and tools', async () => {
    // Pinned from Grok Build 1.0.41 updates.jsonl (ACP session/update stream).
    await writeFile(transcriptPath, `${[
      update('user_message_chunk', text('Read target.txt'), { agentTimestampMs: 1788790183651 }),
      update('agent_thought_chunk', text('thinking'), { promptId: 'p1' }),
      update('agent_message_chunk', text("I'll read "), { promptId: 'p1', agentTimestampMs: 1788790186486 }),
      update('agent_message_chunk', text('it first.'), { promptId: 'p1', agentTimestampMs: 1788790186500 }),
      update('tool_call', { title: 'read' }, { promptId: 'p1' }),
      update('agent_message_chunk', text('It says hello.'), { promptId: 'p1', agentTimestampMs: 1788790190000 }),
      JSON.stringify({ timestamp: 1788790191, method: '_x.ai/session/update', params: { update: { sessionUpdate: 'turn_completed', prompt_id: 'p1' } } }),
      '{"timestamp":1788790192,"method":"session/update","params":{"update":{"sessionUpdate":"agent_mess',
    ].join('\n')}\n`)

    await expect(grokSessionStore.conversation({ session: session(), homeDir })).resolves.toEqual([
      { role: 'user', text: 'Read target.txt', createdAt: '2026-09-07T14:09:43.651Z' },
      { role: 'assistant', text: "I'll read it first.", createdAt: '2026-09-07T14:09:46.486Z' },
      { role: 'assistant', text: 'It says hello.', createdAt: '2026-09-07T14:09:50.000Z' },
    ])
  })

  it('finds the session by id without a transcript path, and null when absent', async () => {
    await writeFile(transcriptPath, `${update('user_message_chunk', text('Hi'), {}, 1788790183)}\n`)

    await expect(grokSessionStore.conversation({ session: session({ transcriptPath: undefined }), homeDir }))
      .resolves.toEqual([{ role: 'user', text: 'Hi', createdAt: '2026-09-07T14:09:43.000Z' }])
    await expect(grokSessionStore.conversation({ session: session({ transcriptPath: undefined, sessionId: 'missing' }), homeDir }))
      .resolves.toBeNull()
  })
})
