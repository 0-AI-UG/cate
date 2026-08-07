import { describe, expect, it } from 'vitest'
import type { CodingAgentRunSnapshot } from '../../../shared/codingAgentRuns'
import {
  actionableCodingAgentRunIds,
  changedCodingAgentRunIds,
  codingAgentWaitMs,
  compactCodingAgentSnapshot,
} from './codingAgentWait'

function run(id: string, status: CodingAgentRunSnapshot['status']): CodingAgentRunSnapshot {
  return {
    id,
    status,
    agentId: 'codex',
    agentName: 'Codex',
    panelId: `panel-${id}`,
    ownerPanelId: 'owner-1',
    prompt: 'Test',
    createdAt: 1,
    cwd: '/repo',
    alive: true,
    followUpSupported: true,
  }
}

describe('coding-agent wait policy', () => {
  it('uses a short default while bounding explicit waits', () => {
    expect(codingAgentWaitMs(undefined)).toBe(10_000)
    expect(codingAgentWaitMs(1)).toBe(5_000)
    expect(codingAgentWaitMs(45)).toBe(45_000)
    expect(codingAgentWaitMs(999)).toBe(60_000)
  })

  it('wakes for actionable current states and meaningful transitions', () => {
    expect(actionableCodingAgentRunIds([
      run('working', 'working'),
      run('blocked', 'waiting'),
      run('done', 'ready'),
    ])).toEqual(['blocked', 'done'])

    const baseline = new Map<string, CodingAgentRunSnapshot['status']>([
      ['starting', 'starting'],
      ['steady', 'working'],
    ])
    expect(changedCodingAgentRunIds(baseline, [
      run('starting', 'working'),
      run('steady', 'waiting'),
    ])).toEqual(['steady'])
  })

  it('keeps routine results free of repeated prompts and follow-up history', () => {
    const snapshot = {
      ...run('worker', 'working'),
      prompt: 'A very long task the supervisor already sent',
      followUps: [{ prompt: 'Another long prompt', sentAt: 2 }],
      statusLine: 'Running tests',
    }

    expect(compactCodingAgentSnapshot(snapshot)).toEqual({
      id: 'worker',
      agentId: 'codex',
      agentName: 'Codex',
      panelId: 'panel-worker',
      status: 'working',
      cwd: '/repo',
      alive: true,
      followUpSupported: true,
      background: true,
      statusLine: 'Running tests',
    })
  })
})
