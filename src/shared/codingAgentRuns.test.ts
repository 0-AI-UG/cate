import { describe, expect, it } from 'vitest'
import { codingAgentCommand, parseCodingAgentId } from './codingAgentRuns'

describe('codingAgentCommand', () => {
  it('resolves only canonical agent ids to exact argv without a shell', () => {
    expect(codingAgentCommand({
      agentId: 'codex',
      prompt: 'Fix it; touch /tmp/pwned',
    })).toEqual({
      executable: 'codex',
      args: ['Complete this coding task:\n\nFix it; touch /tmp/pwned'],
    })
    expect(codingAgentCommand({
      agentId: 'opencode',
      prompt: 'Implement the parser',
    })).toEqual({
      executable: 'opencode',
      args: ['run', 'Complete this coding task:\n\nImplement the parser'],
    })
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
