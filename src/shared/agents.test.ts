import { describe, it, expect } from 'vitest'
import { matchAgentDef, matchAgentProcess, resumeCommandForAgent } from './agents'

describe('matchAgentDef', () => {
  it('resolves the AgentDef for a detected process name, case-insensitively', () => {
    expect(matchAgentDef('claude')?.id).toBe('claude-code')
    expect(matchAgentDef('Codex')?.id).toBe('codex')
    // The CLI's launcher is cursor-agent; comm can also surface as cursor.
    expect(matchAgentDef('cursor-agent')?.id).toBe('cursor')
    expect(matchAgentDef('cursor')?.id).toBe('cursor')
    expect(matchAgentDef('node')).toBeNull()
  })

  it('keeps matchAgentProcess returning the display name', () => {
    expect(matchAgentProcess('opencode')).toBe('OpenCode')
    expect(matchAgentProcess('zsh')).toBeNull()
  })
})

describe('resumeCommandForAgent', () => {
  // These argv shapes are pinned live against the real CLIs by the resume
  // steps of agentHookContracts.itest.ts — keep the two in sync.
  it('builds the pinned resume command per agent', () => {
    const uuid = '11111111-1111-4111-8111-111111111111'
    expect(resumeCommandForAgent('claude-code', uuid)).toBe(`claude --resume ${uuid}`)
    expect(resumeCommandForAgent('codex', uuid)).toBe(`codex resume ${uuid}`)
    expect(resumeCommandForAgent('cursor', uuid)).toBe(`cursor-agent --resume ${uuid}`)
    expect(resumeCommandForAgent('grok', uuid)).toBe(`grok --resume ${uuid}`)
    expect(resumeCommandForAgent('pi', uuid)).toBe(`pi --session ${uuid}`)
    expect(resumeCommandForAgent('opencode', 'ses_abc123')).toBe('opencode --session ses_abc123')
  })

  it('returns null for unknown agent ids', () => {
    expect(resumeCommandForAgent('nonsense', 'abc')).toBeNull()
  })

  it('rejects session ids that are not bare shell-safe tokens', () => {
    expect(resumeCommandForAgent('claude-code', 'abc; rm -rf ~')).toBeNull()
    expect(resumeCommandForAgent('claude-code', 'abc def')).toBeNull()
    expect(resumeCommandForAgent('claude-code', '$(evil)')).toBeNull()
    expect(resumeCommandForAgent('claude-code', '')).toBeNull()
  })

  it('rejects dash-led session ids (flag injection into the resume argv)', () => {
    expect(resumeCommandForAgent('claude-code', '--dangerously-skip-permissions')).toBeNull()
    expect(resumeCommandForAgent('codex', '-x')).toBeNull()
    expect(resumeCommandForAgent('opencode', '_leading-underscore')).toBeNull()
  })
})
