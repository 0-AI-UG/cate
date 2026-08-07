import { describe, expect, it } from 'vitest'
import { AGENTS } from './agents'
import {
  codingAgentCommand,
  codingAgentSupportsFollowUp,
  parseCodingAgentId,
} from './codingAgentRuns'

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
      { id: 'opencode', command: { executable: 'opencode', args: ['run', prefixed] }, followUp: false },
      { id: 'pi', command: { executable: 'pi', args: [prefixed] }, followUp: true },
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
    expect(() => codingAgentCommand({ agentId: 'pi', prompt: '   ' })).toThrow(
      'A coding-agent prompt is required',
    )
  })
})
