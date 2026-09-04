import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveKiroTitle } from './kiro'

const SESSION_ID = 'sess_12345678-1234-4123-8123-123456789abc'
const WORKSPACE_KEY = '0123456789abcdef'

let homeDir = ''

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'cate-kiro-title-'))
})

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true })
})

function event(sessionId: string | null = SESSION_ID): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'kiro',
    kind: 'turn-end',
    sessionId,
    raw: {},
  }
}

async function writeMetadata(value: unknown, workspaceKey = WORKSPACE_KEY): Promise<void> {
  const dir = path.join(homeDir, '.kiro', 'sessions', workspaceKey, SESSION_ID)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(value))
}

describe('resolveKiroTitle', () => {
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

    await expect(resolveKiroTitle({ event: event(), homeDir }))
      .resolves.toBe('Implement automatic terminal titles')
  })

  it('finds the session across opaque workspace directories', async () => {
    await writeMetadata({ id: 'another-session', title: 'Wrong chat' }, 'aaaaaaaaaaaaaaaa')
    await writeMetadata({ id: SESSION_ID, title: 'Matching Kiro chat' })

    await expect(resolveKiroTitle({ event: event(), homeDir }))
      .resolves.toBe('Matching Kiro chat')
  })

  it('uses the current title after Kiro rewrites metadata on rename', async () => {
    await writeMetadata({ id: SESSION_ID, title: 'Initial generated title' })
    await expect(resolveKiroTitle({ event: event(), homeDir }))
      .resolves.toBe('Initial generated title')

    await writeMetadata({ id: SESSION_ID, title: 'Renamed in Kiro' })
    await expect(resolveKiroTitle({ event: event(), homeDir }))
      .resolves.toBe('Renamed in Kiro')
  })

  it('returns null for absent, malformed, mismatched, or unsafe state', async () => {
    await expect(resolveKiroTitle({ event: event(), homeDir })).resolves.toBeNull()
    await expect(resolveKiroTitle({ event: event(null), homeDir })).resolves.toBeNull()
    await expect(resolveKiroTitle({ event: event('../session'), homeDir })).resolves.toBeNull()

    await writeMetadata({ id: 'another-session', title: 'Wrong chat' })
    await expect(resolveKiroTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeMetadata({ id: SESSION_ID, title: '   ' })
    await expect(resolveKiroTitle({ event: event(), homeDir })).resolves.toBeNull()

    const file = path.join(homeDir, '.kiro', 'sessions', WORKSPACE_KEY, SESSION_ID, 'session.json')
    await writeFile(file, '{partial')
    await expect(resolveKiroTitle({ event: event(), homeDir })).resolves.toBeNull()
  })
})
