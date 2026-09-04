import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveCursorTitle } from './cursor'

const SESSION_ID = '12345678-1234-4123-8123-123456789abc'
const WORKSPACE_KEY = '0123456789abcdef0123456789abcdef'

let homeDir: string

function event(sessionId: string | null = SESSION_ID): AgentHookEvent {
  return {
    terminalId: 'terminal-1',
    agentId: 'cursor',
    kind: 'turn-end',
    sessionId,
    raw: {},
  }
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

describe('resolveCursorTitle', () => {
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

    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBe('Repair terminal restore')
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

    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBe('Use the matching session')
  })

  test('returns null until Cursor materializes a nonblank title', async () => {
    await writeMeta({
      schemaVersion: 1,
      createdAtMs: 1,
      hasConversation: false,
      updatedAtMs: 1,
      cwd: '/workspace/project',
    })
    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeMeta({ schemaVersion: 1, hasConversation: true, title: '   ' })
    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeMeta({ schemaVersion: 1, hasConversation: true, title: 'Title generated later' })
    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBe('Title generated later')
  })

  test('returns null for absent state, invalid metadata, and unsafe session ids', async () => {
    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeMeta('{not an object}')
    await expect(resolveCursorTitle({ event: event(), homeDir })).resolves.toBeNull()

    await expect(resolveCursorTitle({ event: event(null), homeDir })).resolves.toBeNull()
    await expect(resolveCursorTitle({ event: event('../meta'), homeDir })).resolves.toBeNull()
  })
})
