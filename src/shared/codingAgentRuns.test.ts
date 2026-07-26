import { describe, expect, it } from 'vitest'
import { codingAgentCommand, parseCodingAgentId } from './codingAgentRuns'

describe('codingAgentCommand', () => {
  it('resolves only canonical agent ids to exact argv without a shell', () => {
    expect(codingAgentCommand({
      agentId: 'codex',
      prompt: 'Fix it; touch /tmp/pwned',
    })).toEqual({
      executable: 'codex',
      args: ['Fix it; touch /tmp/pwned'],
    })
    expect(codingAgentCommand({
      agentId: 'opencode',
      prompt: 'Implement the parser',
    })).toEqual({
      executable: 'opencode',
      args: ['run', 'Implement the parser'],
    })
  })

  it('rejects unknown ids and blank tasks', () => {
    expect(parseCodingAgentId('/tmp/fake-agent')).toBeNull()
    expect(parseCodingAgentId('codex')).toBe('codex')
    expect(() => codingAgentCommand({ agentId: 'pi', prompt: '   ' })).toThrow(
      'A coding-agent prompt is required',
    )
  })
})
