import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentSessionLocator } from './types'
import { cursorSessionStore, parseCursorTimestamp } from './cursor'

const SESSION_ID = '12345678-1234-4123-8123-123456789abc'
const WORKSPACE_KEY = '0123456789abcdef0123456789abcdef'

let homeDir: string

function session(sessionId = SESSION_ID): AgentSessionLocator {
  return { agentId: 'cursor', sessionId }
}

async function writeMeta(value: unknown, workspaceKey = WORKSPACE_KEY): Promise<void> {
  const dir = path.join(homeDir, '.cursor', 'chats', workspaceKey, SESSION_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'meta.json'), JSON.stringify(value))
}

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-cursor-title-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

describe('Cursor session title', () => {
  test('reads Cursor\'s own title from schema-v1 conversation metadata', async () => {
    // Cursor Agent 2026.07.16-899851b persists chat metadata under the
    // conversation id inside an opaque 32-hex workspace directory.
    await writeMeta({
      schemaVersion: 1,
      createdAtMs: 1,
      hasConversation: true,
      title: 'Repair terminal restore',
      updatedAtMs: 2,
      cwd: '/workspace/project',
    })

    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBe('Repair terminal restore')
  })

  test('finds the conversation across Cursor\'s opaque workspace directories', async () => {
    const other = path.join(
      homeDir,
      '.cursor',
      'chats',
      '00000000000000000000000000000000',
      SESSION_ID,
    )
    await mkdir(other, { recursive: true })
    await writeFile(path.join(other, 'meta.json'), '{not-json')
    await writeMeta({ schemaVersion: 1, title: 'Use the matching session' }, WORKSPACE_KEY)

    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBe('Use the matching session')
  })

  test('returns null until Cursor materializes a nonblank title', async () => {
    await writeMeta({
      schemaVersion: 1,
      createdAtMs: 1,
      hasConversation: false,
      updatedAtMs: 1,
      cwd: '/workspace/project',
    })
    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await writeMeta({ schemaVersion: 1, hasConversation: true, title: '   ' })
    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await writeMeta({ schemaVersion: 1, hasConversation: true, title: 'Title generated later' })
    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBe('Title generated later')
  })

  test('returns null for absent state, invalid metadata, and unsafe session ids', async () => {
    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await writeMeta('{not an object}')
    await expect(cursorSessionStore.title({ session: session(), homeDir })).resolves.toBeNull()

    await expect(cursorSessionStore.title({ session: session(''), homeDir })).resolves.toBeNull()
    await expect(cursorSessionStore.title({ session: session('../meta'), homeDir })).resolves.toBeNull()
  })
})

describe('Cursor session conversation', () => {
  const user = (stamp: string, query: string) => ({
    role: 'user',
    message: { content: [{ type: 'text', text: `<timestamp>${stamp}</timestamp>\n<user_query>\n${query}\n</user_query>` }] },
  })
  const assistant = (...blocks: unknown[]) => ({ role: 'assistant', message: { content: blocks } })

  async function writeTranscript(slug: string, records: unknown[]): Promise<string> {
    const dir = path.join(homeDir, '.cursor', 'projects', slug, 'agent-transcripts', SESSION_ID)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(file, `${records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n')}\n`)
    return file
  }

  test('parses Cursor prompt timestamps with their UTC offset', () => {
    expect(parseCursorTimestamp('Sunday, Sep 27, 2026, 12:36 PM (UTC+2)')).toBe('2026-09-27T10:36:00.000Z')
    expect(parseCursorTimestamp('Monday, Jan 5, 2026, 12:05 AM (UTC-5:30)')).toBe('2026-01-05T05:35:00.000Z')
    expect(parseCursorTimestamp('not a date')).toBeUndefined()
  })

  test('extracts user queries and concatenates a turn\'s assistant steps', async () => {
    // Pinned from Cursor Agent 2026.09.02: no envelope, one assistant record
    // per model step, prompt time only inside the <timestamp> tag.
    const file = await writeTranscript('Users-me-project', [
      user('Sunday, Sep 27, 2026, 12:36 PM (UTC+2)', 'Fix the build'),
      assistant({ type: 'text', text: 'Reading the config.\n\n[REDACTED]' }, { type: 'tool_use', name: 'Shell', input: {} }),
      assistant({ type: 'text', text: 'Fixed it.' }),
      { type: 'turn_ended', status: 'success' },
      user('Sunday, Sep 27, 2026, 12:40 PM (UTC+2)', 'Thanks'),
      assistant({ type: 'tool_use', name: 'Shell', input: {} }),
      '{"role":"assistant","message":{"content":[{"type":"text","text":"parti',
    ])

    await expect(cursorSessionStore.conversation({ session: { ...session(), transcriptPath: file }, homeDir })).resolves.toEqual([
      { role: 'user', text: 'Fix the build', createdAt: '2026-09-27T10:36:00.000Z' },
      { role: 'assistant', text: 'Reading the config.\n\nFixed it.', createdAt: '2026-09-27T10:36:00.000Z' },
      { role: 'user', text: 'Thanks', createdAt: '2026-09-27T10:40:00.000Z' },
    ])
  })

  test('locates the transcript by cwd slug, then by project scan', async () => {
    await writeTranscript('Users-me-my-project', [user('Sunday, Sep 27, 2026, 12:36 PM (UTC+2)', 'Hi')])

    await expect(cursorSessionStore.conversation({ session: { ...session(), cwd: '/Users/me/my_project' }, homeDir }))
      .resolves.toHaveLength(1)
    await expect(cursorSessionStore.conversation({ session: { ...session(), cwd: '/elsewhere' }, homeDir }))
      .resolves.toHaveLength(1)
    await expect(cursorSessionStore.conversation({ session: session('00000000-0000-4000-8000-000000000000'), homeDir }))
      .resolves.toBeNull()
  })
})
