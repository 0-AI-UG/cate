import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kiroSessionStore } from './kiro'
import type { AgentSessionContext } from './types'

const SESSION_ID = 'sess_12345678-1234-4123-8123-123456789abc'
const WORKSPACE_KEY = '0123456789abcdef'

let homeDir = ''

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-kiro-title-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

function context(sessionId: string | null = SESSION_ID, cwd?: string): AgentSessionContext {
  return { session: { agentId: 'kiro', sessionId: sessionId ?? '', cwd }, homeDir }
}

async function writeMetadata(value: unknown, workspaceKey = WORKSPACE_KEY): Promise<void> {
  const dir = path.join(homeDir, '.kiro', 'sessions', workspaceKey, SESSION_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(value))
}

describe('Kiro session title', () => {
  it('reads Kiro\'s native title from schema-1 session metadata', async () => {
    // Pinned against Kiro CLI 2.19: the session picker reads this metadata
    // under an opaque 16-hex workspace key, separate from messages.jsonl.
    await writeMetadata({
      schemaVersion: '1.0.0',
      dataModelVersion: 1,
      id: SESSION_ID,
      title: 'Implement automatic terminal titles',
      workspacePaths: ['/workspace/project'],
      createdAt: '2026-09-03T10:00:00Z',
      lastModifiedAt: '2026-09-03T10:01:00Z',
    })

    await expect(kiroSessionStore.title(context()))
      .resolves.toBe('Implement automatic terminal titles')
  })

  it('finds the session across opaque workspace directories', async () => {
    await writeMetadata({ id: 'another-session', title: 'Wrong chat' }, 'aaaaaaaaaaaaaaaa')
    await writeMetadata({ id: SESSION_ID, title: 'Matching Kiro chat' })

    await expect(kiroSessionStore.title(context()))
      .resolves.toBe('Matching Kiro chat')
  })

  it('uses the current title after Kiro rewrites metadata on rename', async () => {
    await writeMetadata({ id: SESSION_ID, title: 'Initial generated title' })
    await expect(kiroSessionStore.title(context()))
      .resolves.toBe('Initial generated title')

    await writeMetadata({ id: SESSION_ID, title: 'Renamed in Kiro' })
    await expect(kiroSessionStore.title(context()))
      .resolves.toBe('Renamed in Kiro')
  })

  it('returns null for absent, malformed, mismatched, or unsafe state', async () => {
    await expect(kiroSessionStore.title(context())).resolves.toBeNull()
    await expect(kiroSessionStore.title(context(null))).resolves.toBeNull()
    await expect(kiroSessionStore.title(context('../session'))).resolves.toBeNull()

    await writeMetadata({ id: 'another-session', title: 'Wrong chat' })
    await expect(kiroSessionStore.title(context())).resolves.toBeNull()

    await writeMetadata({ id: SESSION_ID, title: '   ' })
    await expect(kiroSessionStore.title(context())).resolves.toBeNull()

    const file = path.join(homeDir, '.kiro', 'sessions', WORKSPACE_KEY, SESSION_ID, 'session.json')
    await writeFile(file, '{partial')
    await expect(kiroSessionStore.title(context())).resolves.toBeNull()
  })
})

async function writeMessages(workspaceKey: string, lines: unknown[]): Promise<void> {
  const dir = path.join(homeDir, '.kiro', 'sessions', workspaceKey, SESSION_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'messages.jsonl'), `${lines.map((line) =>
    typeof line === 'string' ? line : JSON.stringify(line)).join('\n')}\n`)
}

const TRANSCRIPT = [
  { id: 'a', timestamp: '2026-08-21T12:14:20.000Z', payload: { type: 'session_start', content: 'system prompt' } },
  { id: 'b', timestamp: '2026-08-21T12:14:26.694Z', payload: { type: 'user', content: 'Reply with exactly: ok', images: [] } },
  { id: 'c', timestamp: '2026-08-21T12:14:28.000Z', payload: { type: 'assistant', content: '...', operationType: 'Reasoning' } },
  { id: 'd', timestamp: '2026-08-21T12:14:29.000Z', payload: { type: 'tool_call', name: 'read' } },
  { id: 'e', timestamp: '2026-08-21T12:14:30.564Z', payload: { type: 'assistant', content: 'ok', operationType: 'Say' } },
  { id: 'f', timestamp: '2026-08-21T12:14:31.000Z', payload: { type: 'turn_end', stopReason: 'end_turn' } },
  '{"id":"partial","payload":{"type":"user","con',
]

describe('Kiro session conversation', () => {
  it('reads user prompts and Say replies in file order from the cwd bucket', async () => {
    // Pinned against Kiro CLI 2.19: the bucket is sha256(realpath(cwd))[:16].
    const cwd = await realpath(homeDir)
    await writeMessages(createHash('sha256').update(cwd).digest('hex').slice(0, 16), TRANSCRIPT)

    await expect(kiroSessionStore.conversation(context(SESSION_ID, cwd))).resolves.toEqual([
      { role: 'user', text: 'Reply with exactly: ok', createdAt: '2026-08-21T12:14:26.694Z' },
      { role: 'assistant', text: 'ok', createdAt: '2026-08-21T12:14:30.564Z' },
    ])
  })

  it('scans workspace buckets when the cwd does not match', async () => {
    await writeMessages(WORKSPACE_KEY, TRANSCRIPT)
    const messages = await kiroSessionStore.conversation(context(SESSION_ID, '/elsewhere'))
    expect(messages?.map((message) => message.text)).toEqual(['Reply with exactly: ok', 'ok'])
  })

  it('returns null for a missing or unsafe session', async () => {
    await expect(kiroSessionStore.conversation(context())).resolves.toBeNull()
    await expect(kiroSessionStore.conversation(context('../session'))).resolves.toBeNull()
  })
})
