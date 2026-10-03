import { describe, expect, it } from 'vitest'
import { AGENTS } from './registry'
import {
  actionableCodingAgentRunIds,
  changedCodingAgentRunIds,
  codingAgentCommand,
  compactCodingAgentSnapshot,
  type CodingAgentRunSnapshot,
  codingAgentSupportsFollowUp,
  parseCodingAgentId,
} from './missions'

describe('codingAgentCommand', () => {
  it('resolves only canonical agent ids to exact argv without a shell', () => {
    const task = 'Fix it; touch /tmp/pwned'
    const prefixed = `Complete this coding task:\n\n${task}`
    expect(AGENTS.map((agent) => ({
      id: agent.id,
      command: codingAgentCommand({ agentId: agent.id, prompt: task }),
      followUp: codingAgentSupportsFollowUp(agent.id),
    }))).toEqual([
      { id: 'claude-code', command: { executable: 'claude', args: [prefixed] }, followUp: true },
      { id: 'codex', command: { executable: 'codex', args: [prefixed] }, followUp: true },
      { id: 'cursor', command: { executable: 'cursor-agent', args: [prefixed] }, followUp: true },
      { id: 'grok', command: { executable: 'grok', args: [prefixed] }, followUp: true },
      { id: 'opencode', command: { executable: 'opencode', args: ['--prompt', prefixed] }, followUp: true },
      { id: 'hermes', command: { executable: 'hermes', args: ['chat', '-q', prefixed] }, followUp: true },
      { id: 'kiro', command: { executable: 'kiro-cli', args: ['chat', '--v3', prefixed] }, followUp: true },
    ])
  })

  it('keeps option-looking and subcommand-looking tasks positional', () => {
    expect(codingAgentCommand({
      agentId: 'codex',
      prompt: '--dangerously-bypass-approvals-and-sandbox',
    }).args).toEqual([
      'Complete this coding task:\n\n--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(codingAgentCommand({
      agentId: 'claude-code',
      prompt: '--dangerously-skip-permissions',
    }).args).toEqual([
      'Complete this coding task:\n\n--dangerously-skip-permissions',
    ])
    expect(codingAgentCommand({ agentId: 'codex', prompt: 'exec' }).args).toEqual([
      'Complete this coding task:\n\nexec',
    ])
  })

  it('rejects unknown ids and blank tasks', () => {
    expect(parseCodingAgentId('/tmp/fake-agent')).toBeNull()
    expect(parseCodingAgentId('codex')).toBe('codex')
    expect(() => codingAgentCommand({ agentId: 'codex', prompt: '   ' })).toThrow(
      'A coding-agent prompt is required',
    )
  })
})

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
