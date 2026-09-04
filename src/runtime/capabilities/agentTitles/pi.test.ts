import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolvePiTitle } from './pi'

let tempDir = ''
let sessionFile = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'cate-pi-title-'))
  sessionFile = path.join(tempDir, 'session.jsonl')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function event(sessionId: string | null = 'session-1', transcriptPath = sessionFile): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'pi',
    kind: 'turn-end',
    sessionId,
    transcriptPath,
    raw: {},
  }
}

async function writeSession(...entries: unknown[]): Promise<void> {
  await writeFile(sessionFile, `${entries.map((entry) => (
    typeof entry === 'string' ? entry : JSON.stringify(entry)
  )).join('\n')}\n`)
}

describe('resolvePiTitle', () => {
  it('uses the latest session_info.name exactly', async () => {
    // Pinned against Pi 0.80.6's append-only session schema: renames add
    // another session_info record, so the final valid value is authoritative.
    await writeSession(
      { type: 'session', version: 3, id: 'session-1', cwd: '/work' },
      { type: 'session_info', name: 'Initial name' },
      { type: 'message', message: { role: 'user', content: 'Fallback prompt' } },
      { type: 'session_info', name: 'Renamed in Pi' },
    )

    await expect(resolvePiTitle({ event: event(), homeDir: '/unused' }))
      .resolves.toBe('Renamed in Pi')
  })

  it('matches Pi\'s unnamed-chat fallback to the first user message', async () => {
    // Pi joins text blocks with spaces, ignores non-text blocks, then replaces
    // control characters and trims the result for its session picker.
    await writeSession(
      { type: 'session', version: 3, id: 'session-1', cwd: '/work' },
      { type: 'message', message: { role: 'assistant', content: 'Not the title' } },
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '  Fix terminal\n' },
            { type: 'image', data: 'ignored' },
            { type: 'text', text: 'title fallback  ' },
          ],
        },
      },
      { type: 'message', message: { role: 'user', content: 'Later prompt' } },
    )

    await expect(resolvePiTitle({ event: event(), homeDir: '/unused' }))
      .resolves.toBe('Fix terminal  title fallback')
  })

  it('falls back after Pi explicitly clears a previously assigned name', async () => {
    await writeSession(
      { type: 'session', version: 3, id: 'session-1', cwd: '/work' },
      { type: 'message', message: { role: 'user', content: 'Use the original prompt' } },
      { type: 'session_info', name: 'Temporary name' },
      { type: 'session_info', name: '' },
      '{"type":"session_info","name":',
    )

    await expect(resolvePiTitle({ event: event(), homeDir: '/unused' }))
      .resolves.toBe('Use the original prompt')
  })

  it('returns null for missing state or a transcript from another session', async () => {
    await expect(resolvePiTitle({ event: event(null), homeDir: '/unused' })).resolves.toBeNull()
    await expect(resolvePiTitle({ event: event('session-1', path.join(tempDir, 'missing.jsonl')), homeDir: '/unused' }))
      .resolves.toBeNull()

    await writeSession(
      { type: 'session', version: 3, id: 'another-session', cwd: '/work' },
      { type: 'session_info', name: 'Wrong chat' },
    )
    await expect(resolvePiTitle({ event: event(), homeDir: '/unused' })).resolves.toBeNull()
  })
})
