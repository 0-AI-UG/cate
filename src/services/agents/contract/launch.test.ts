import { describe, expect, it } from 'vitest'
import { AGENTS } from './registry'
import { agentLaunchCommand, agentTaskText } from './launch'

describe('agentLaunchCommand', () => {
  it('resolves only canonical agent ids to exact argv without a shell', () => {
    const task = 'Fix it; touch /tmp/pwned'
    const prefixed = `Complete this coding task:\n\n${task}`
    expect(AGENTS.map((agent) => ({ id: agent.id, command: agentLaunchCommand({ agentId: agent.id, prompt: task }) }))).toEqual([
      { id: 'claude-code', command: { executable: 'claude', args: [prefixed] } },
      { id: 'codex', command: { executable: 'codex', args: [prefixed] } },
      { id: 'cursor', command: { executable: 'cursor-agent', args: [prefixed] } },
      { id: 'grok', command: { executable: 'grok', args: [prefixed] } },
      { id: 'opencode', command: { executable: 'opencode', args: ['--prompt', prefixed] } },
      { id: 'hermes', command: { executable: 'hermes', args: ['chat', '-q', prefixed] } },
      { id: 'kiro', command: { executable: 'kiro-cli', args: ['chat', '--v3', prefixed] } },
    ])
  })

  it('keeps option-looking and subcommand-looking prompts positional', () => {
    expect(agentLaunchCommand({ agentId: 'codex', prompt: '--dangerously-bypass-approvals-and-sandbox' }).args).toEqual([
      'Complete this coding task:\n\n--dangerously-bypass-approvals-and-sandbox',
    ])
    expect(agentLaunchCommand({ agentId: 'codex', prompt: 'exec' }).args).toEqual(['Complete this coding task:\n\nexec'])
  })

  it('rejects blank prompts', () => {
    expect(() => agentLaunchCommand({ agentId: 'codex', prompt: '   ' })).toThrow('A prompt is required')
  })

  it('shows the prompt as written', () => {
    const [arg] = agentLaunchCommand({ agentId: 'codex', prompt: 'Fix it' }).args
    expect(agentTaskText(arg)).toBe('Fix it')
    expect(agentTaskText('Plain')).toBe('Plain')
  })
})
