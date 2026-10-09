// Registry coverage: the forget-proofing the compiler cannot express. Most
// per-agent tables are total Record<AgentId, ...>, so a new agent is already
// a compile error until each is filled in. The nullable skills target and the
// persisted SkillTargetId values escape that, so they are asserted here.

import { describe, expect, it, test } from 'vitest'
import {
  AGENTS,
  T3_AGENTS,
  agentForLaunchCommand,
  agentIdForT3Provider,
  matchAgentDef,
  resumeCommandForAgent,
  type AgentId,
} from './registry'
import { AGENT_HOOK_SPECS } from './hooks'
import type { SkillTargetId } from '@workspace/skills/contract'

/** Agents deliberately without a skills integration. Add an id here ONLY with a
 *  reason — the point of the failure is to force the decision, not to be muted. */
const NO_SKILLS: ReadonlySet<AgentId> = new Set([])

describe('agent registry coverage', () => {
  test('native prompt context is gated to CLIs with a supported submit hook', () => {
    expect(Object.fromEntries(AGENTS.map((agent) => [agent.id, agent.promptContextHook]))).toEqual({
      'claude-code': 'additional-context',
      codex: 'additional-context',
      cursor: null,
      grok: null,
      hermes: 'plain-text',
      kiro: 'plain-text',
      opencode: 'endpoint',
    })
  })

  test('every agent declares a skills target, or is an explicit omission', () => {
    for (const a of AGENTS) {
      if (NO_SKILLS.has(a.id)) {
        expect(a.skills, `${a.id} is listed as skill-less`).toBeNull()
        continue
      }
      expect(a.skills, `${a.id} has no skills target — declare one or add it to NO_SKILLS`).toBeTruthy()
      // A skills root that is not workspace-relative would escape the workspace.
      expect(a.skills!.baseSegments.length).toBeGreaterThan(0)
      for (const seg of a.skills!.baseSegments) {
        expect(seg, `${a.id} skills segment`).not.toContain('/')
        expect(seg).not.toBe('..')
      }
    }
  })

  test('target ids and skills roots are unique — no two agents share a dir', () => {
    const ids = AGENTS.flatMap((a) => (a.skills ? [a.skills.targetId] : []))
    expect(new Set(ids).size, 'duplicate targetId').toBe(ids.length)
    const roots = AGENTS.flatMap((a) => (a.skills ? [a.skills.baseSegments.join('/')] : []))
    expect(new Set(roots).size, 'two agents installing to the same dir').toBe(roots.length)
  })

  // The persisted ids in every workspace's .cate/skills.json. Renaming one
  // orphans existing installs, so this is a deliberate tripwire, not a
  // restatement of the type.
  test('persisted SkillTargetId values never drift', () => {
    const expected: SkillTargetId[] = [
      'claude-code', 'opencode', 'codex', 'cursor', 'grok', 'hermes', 'kiro',
    ]
    expect(AGENTS.flatMap((a) => (a.skills ? [a.skills.targetId] : [])).sort()).toEqual([...expected].sort())
  })

  test('every agent has a hook spec', () => {
    // Total Record, so this is belt-and-braces — but it also catches a spec
    // that is present and empty (no injection channel at all).
    for (const a of AGENTS) {
      const spec = AGENT_HOOK_SPECS[a.id]
      expect(spec, `${a.id} hook spec`).toBeTruthy()
      expect(Boolean(spec.projectFiles?.length || spec.externalPlugin), `${a.id} has no injection channel`).toBe(true)
    }
  })

  test('every agent has a launch command and a resume decision', () => {
    for (const a of AGENTS) {
      const { command, resume } = a.runners.terminal
      expect(command, `${a.id} command`).toBeTruthy()
      expect(a.matchProcess(command.toLowerCase()) || a.id === 'claude-code',
        `${a.id} does not detect its own command name`).toBe(true)
      // resumeArgs is nullable by design (a CLI may not resume by id) — assert
      // it is a real decision, and that the argv it builds is non-empty.
      if (resume.args && a.id !== 'hermes') expect(resume.args('abc')?.length).toBeGreaterThan(0)
    }
  })
})

test('the t3 runner exists exactly for claude-code, codex, cursor, grok and opencode', () => {
  expect(T3_AGENTS.map((a) => a.id)).toEqual(['claude-code', 'codex', 'cursor', 'grok', 'opencode'])
  expect(T3_AGENTS.map((a) => a.runners.t3.providerId).sort()).toEqual(['claude', 'codex', 'cursor', 'grok', 'opencode'])
  for (const provider of T3_AGENTS) expect(provider.skills).not.toBeNull()
})

test('T3 provider and driver ids resolve to canonical execution identities', () => {
  expect(agentIdForT3Provider('codex')).toBe('codex')
  expect(agentIdForT3Provider('claude')).toBe('claude-code')
  expect(agentIdForT3Provider('claudeAgent')).toBe('claude-code')
  expect(agentIdForT3Provider('unknown')).toBeNull()
})

describe('agentForLaunchCommand', () => {
  it('recognizes a bare driver launch command, including an absolute path', () => {
    expect(agentForLaunchCommand('claude')?.id).toBe('claude-code')
    expect(agentForLaunchCommand('/usr/local/bin/codex --some-flag')?.id).toBe('codex')
    expect(agentForLaunchCommand('"C:\\tools\\cursor-agent"')?.id).toBe('cursor')
    expect(agentForLaunchCommand('/usr/local/bin/kiro-cli chat')?.id).toBe('kiro')
    expect(agentForLaunchCommand('hermes chat')?.id).toBe('hermes')
  })

  it('does not guess through compound shell syntax', () => {
    expect(agentForLaunchCommand('FOO=1 claude')).toBeNull()
    expect(agentForLaunchCommand('npm test')).toBeNull()
  })
})

describe('matchAgentDef', () => {
  it('resolves the AgentDef for a detected process name, case-insensitively', () => {
    expect(matchAgentDef('claude')?.id).toBe('claude-code')
    expect(matchAgentDef('Codex')?.id).toBe('codex')
    // The CLI's launcher is cursor-agent; comm can also surface as cursor.
    expect(matchAgentDef('cursor-agent')?.id).toBe('cursor')
    expect(matchAgentDef('cursor')?.id).toBe('cursor')
    expect(matchAgentDef('kiro-cli')?.id).toBe('kiro')
    expect(matchAgentDef('hermes')?.id).toBe('hermes')
    expect(matchAgentDef('node')).toBeNull()
  })

  it('matches claude by exact command name, not prefix', () => {
    expect(matchAgentDef('claude-code')?.id).toBe('claude-code')
    expect(matchAgentDef('claude-foo')).toBeNull()
    expect(matchAgentDef('claudette')).toBeNull()
  })
})

describe('resumeCommandForAgent', () => {
  // These argv shapes were verified live against the real CLIs.
  it('builds the pinned resume command per agent', () => {
    const uuid = '11111111-1111-4111-8111-111111111111'
    expect(resumeCommandForAgent('claude-code', uuid)).toBe(`claude --resume ${uuid}`)
    expect(resumeCommandForAgent('codex', uuid)).toBe(`codex resume ${uuid}`)
    expect(resumeCommandForAgent('cursor', uuid)).toBe(`cursor-agent --resume ${uuid}`)
    expect(resumeCommandForAgent('grok', uuid)).toBe(`grok --resume ${uuid}`)
    expect(resumeCommandForAgent('opencode', 'ses_abc123')).toBe('opencode --session ses_abc123')
    expect(resumeCommandForAgent('kiro', uuid)).toBe(`kiro-cli chat --v3 --resume-id ${uuid}`)
    expect(resumeCommandForAgent('hermes', uuid, { profile: 'work' })).toBe(`hermes --profile work chat --resume ${uuid}`)
    expect(resumeCommandForAgent('hermes', uuid)).toBeNull()
    expect(resumeCommandForAgent('hermes', uuid, { profile: 'custom' })).toBeNull()
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
