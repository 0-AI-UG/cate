import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookEvent } from '../../../shared/agentHooks'
import { resolveGrokTitle } from './grok'

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

function event(overrides: Partial<AgentHookEvent> = {}): AgentHookEvent {
  return {
    terminalId: 'pty-1',
    agentId: 'grok',
    kind: 'turn-end',
    sessionId: 'session-1',
    transcriptPath,
    raw: {},
    ...overrides,
  }
}

async function writeSummary(summary: unknown): Promise<void> {
  await writeFile(path.join(path.dirname(transcriptPath), 'summary.json'), JSON.stringify(summary))
}

describe('resolveGrokTitle', () => {
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

    await expect(resolveGrokTitle({ event: event(), homeDir }))
      .resolves.toBe('Implement automatic terminal titles')
  })

  it('uses the current generated_title after /rename overwrites summary.json', async () => {
    await writeSummary({
      generated_title: 'Generated title',
      title_is_manual: false,
    })
    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBe('Generated title')

    // Grok keeps manual and generated titles in the same field. The boolean
    // records provenance; it does not select a second title field.
    await writeSummary({
      generated_title: 'Manually renamed title',
      title_is_manual: true,
    })
    await expect(resolveGrokTitle({ event: event(), homeDir }))
      .resolves.toBe('Manually renamed title')
  })

  it('does not substitute session_summary while a native title is unavailable', async () => {
    await writeSummary({
      session_summary: 'This is metadata, not Grok\'s picker title',
      generated_title: null,
      title_is_manual: false,
    })
    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeSummary({ generated_title: '   ', title_is_manual: true })
    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBeNull()
  })

  it('returns null for missing identity, transcript, or valid summary metadata', async () => {
    await expect(resolveGrokTitle({
      event: event({ sessionId: null }),
      homeDir,
    })).resolves.toBeNull()
    await expect(resolveGrokTitle({
      event: event({ transcriptPath: undefined }),
      homeDir,
    })).resolves.toBeNull()

    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBeNull()
    await writeFile(path.join(path.dirname(transcriptPath), 'summary.json'), '{partial')
    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBeNull()

    await writeSummary({ generated_title: 42 })
    await expect(resolveGrokTitle({ event: event(), homeDir })).resolves.toBeNull()
  })
})
