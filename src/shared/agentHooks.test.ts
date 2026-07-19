// =============================================================================
// Unit tests for the per-agent hook declarations. Payload fixtures mirror the
// shapes captured live by agentHookContracts.itest.ts — when that suite pins a
// new shape, the fixture here follows it.
// =============================================================================

import { describe, expect, test } from 'vitest'
import {
  AGENT_HOOK_SPECS,
  CATE_HOOK_MARKER,
  codexTrustedHash,
  normalizeAgentHookPayload,
  sessionPreassignEnvVar,
  type HookInjectionContext,
} from './agentHooks'

const ctx: HookInjectionContext = {
  bridgeCommand: '/cate/hooks/cate-hook-bridge-x',
  filePath: '/cate/hooks/support-file',
}

const norm = (agentId: string, payload: Record<string, unknown>) =>
  normalizeAgentHookPayload(agentId, 'term-1', payload)

describe('codex trusted hash', () => {
  test('pinned vector — the exact builder verified live against codex', () => {
    // If this drifts, the live contract suite is the authority; both must move
    // together with a codex release that changes the trust scheme.
    expect(codexTrustedHash('session_start', '/cate/hooks/bridge-codex', 60)).toBe(
      'sha256:45b23f6911ff81a78ed16f786e7ff25cad505d52d656cab9b3236565677d2c37',
    )
  })
})

describe('claude spec', () => {
  const spec = AGENT_HOOK_SPECS['claude-code']
  const base = {
    session_id: '11111111-2222-4333-8444-555555555555',
    transcript_path: '/home/u/.claude/projects/slug/1111.jsonl',
    cwd: '/home/u/proj',
  }

  const file = spec.projectFiles![0]

  test('shim injects NO argv (hooks ride the project file; PATH shims are bypassable)', () => {
    // Regression: --settings hook injection via the PATH shim silently died
    // for every user whose shell rc prepends the CLI's install dir (uv/bun
    // boilerplate prepends ~/.local/bin — where claude lives). Hooks must not
    // depend on the shim; it survives only for session pre-assignment.
    expect(spec.shim!.args(ctx)).toEqual([])
  })

  test('creates .claude/settings.local.json with the bridge on all six hook events', () => {
    expect(file.relPath).toBe('.claude/settings.local.json')
    const out = file.build(null, ctx)!
    const parsed = JSON.parse(out) as { hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>> }
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    )
    for (const groups of Object.values(parsed.hooks)) {
      expect(groups).toHaveLength(1)
      expect(groups[0].hooks[0]).toEqual({ type: 'command', command: ctx.bridgeCommand })
    }
  })

  test('merges into an existing settings.local.json: user fields/hooks kept, stale Cate groups refreshed', () => {
    const existing = JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] }, // claude's own "always allow" grants
      hooks: {
        Stop: [
          { matcher: '*', hooks: [{ type: 'command', command: '/home/u/my-stop-hook.sh' }] },
          { hooks: [{ type: 'command', command: `/old-boot-dir/${CATE_HOOK_MARKER}-bridge-claude-code` }] },
        ],
      },
    })
    const out = file.build(existing, ctx)!
    const parsed = JSON.parse(out) as {
      permissions: unknown
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>
    }
    expect(parsed.permissions).toEqual({ allow: ['Bash(npm test)'] })
    const stopCommands = parsed.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
    expect(stopCommands).toContain('/home/u/my-stop-hook.sh')
    expect(stopCommands).toContain(ctx.bridgeCommand)
    expect(stopCommands).not.toContain(`/old-boot-dir/${CATE_HOOK_MARKER}-bridge-claude-code`)
    // Every tracked event gained our group.
    expect(parsed.hooks.UserPromptSubmit.flatMap((g) => g.hooks.map((h) => h.command))).toContain(ctx.bridgeCommand)
  })

  test('leaves an unparseable settings file alone; identical rewrite is a no-op', () => {
    expect(file.build('{not json', ctx)).toBeNull()
    const fresh = file.build(null, ctx)!
    expect(file.build(fresh, ctx)).toBeNull()
  })

  test('preassign declares --session-id gated on session-affecting argv', () => {
    expect(spec.shim!.preassign!.flag).toBe('--session-id')
    for (const b of ['--resume', '-r', '--continue', '-c', '--session-id', 'resume']) {
      expect(spec.shim!.preassign!.blockers).toContain(b)
    }
    expect(sessionPreassignEnvVar('claude-code')).toBe('CATE_SESSION_PREASSIGN_CLAUDE_CODE')
  })

  test('lifecycle events normalize with identity fields', () => {
    const start = norm('claude-code', { hook_event_name: 'SessionStart', source: 'startup', ...base })
    expect(start).toMatchObject({
      agentId: 'claude-code',
      terminalId: 'term-1',
      kind: 'session-start',
      sessionId: base.session_id,
      cwd: base.cwd,
      transcriptPath: base.transcript_path,
    })
    expect(norm('claude-code', { hook_event_name: 'UserPromptSubmit', ...base })?.kind).toBe('turn-start')
    expect(norm('claude-code', { hook_event_name: 'Stop', ...base })?.kind).toBe('turn-end')
    expect(norm('claude-code', { hook_event_name: 'SessionEnd', reason: 'clear', ...base })?.kind).toBe('session-end')
  })

  test('Notification maps permission_prompt to permission-wait and drops idle_prompt', () => {
    expect(
      norm('claude-code', {
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash',
        ...base,
      })?.kind,
    ).toBe('permission-wait')
    expect(
      norm('claude-code', { hook_event_name: 'Notification', notification_type: 'idle_prompt', ...base }),
    ).toBeNull()
  })

  test('PostToolUse maps to turn-resume (approval resolution / ordinary tool call)', () => {
    const resume = norm('claude-code', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'touch needs-approval.txt' },
      tool_response: { stdout: '', stderr: '', interrupted: false },
      ...base,
    })
    expect(resume?.kind).toBe('turn-resume')
    expect(resume?.sessionId).toBe(base.session_id)
    expect(file.build(null, ctx)).toContain('PostToolUse')
  })
})

describe('codex spec', () => {
  const spec = AGENT_HOOK_SPECS.codex

  test('shim args carry the -c hook overrides plus a matching hooks.state trust table', () => {
    const args = spec.shim!.args(ctx)
    // Alternating -c/value pairs.
    for (let i = 0; i < args.length; i += 2) expect(args[i]).toBe('-c')
    const values = args.filter((_, i) => i % 2 === 1)
    // CamelCase TOML keys for the hook arrays…
    for (const toml of ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop']) {
      const entry = values.find((v) => v.startsWith(`hooks.${toml}=`))
      expect(entry, `hooks.${toml}`).toBeTruthy()
      expect(entry).toContain(`command="${ctx.bridgeCommand}"`)
      expect(entry).toContain('timeout=60')
    }
    // …snake_case labels in the ONE inline hooks.state table, each with the
    // self-supplied trusted_hash (untrusted hooks are silently skipped).
    const state = values.find((v) => v.startsWith('hooks.state='))
    expect(state).toBeTruthy()
    for (const label of ['session_start', 'user_prompt_submit', 'permission_request', 'post_tool_use', 'stop']) {
      expect(state).toContain(`"/<session-flags>/config.toml:${label}:0:0"`)
      expect(state).toContain(codexTrustedHash(label, ctx.bridgeCommand, 60))
    }
  })

  test('normalizes lifecycle + PermissionRequest', () => {
    const base = {
      session_id: '99999999-1111-4222-8333-444444444444',
      cwd: '/w',
      transcript_path: '/home/u/.codex/sessions/rollout-x.jsonl',
    }
    expect(norm('codex', { hook_event_name: 'SessionStart', source: 'startup', ...base })).toMatchObject({
      kind: 'session-start',
      sessionId: base.session_id,
      transcriptPath: base.transcript_path,
    })
    expect(norm('codex', { hook_event_name: 'UserPromptSubmit', ...base })?.kind).toBe('turn-start')
    const perm = norm('codex', {
      hook_event_name: 'PermissionRequest',
      ...base,
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_input: { command: 'touch needs-approval.txt' },
    })
    expect(perm?.kind).toBe('permission-wait')
    expect(perm?.raw.turn_id).toBe('turn-1')
    expect(
      norm('codex', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'touch x' }, ...base })
        ?.kind,
    ).toBe('turn-resume')
    expect(norm('codex', { hook_event_name: 'Stop', ...base })?.kind).toBe('turn-end')
  })
})

describe('pi spec', () => {
  const spec = AGENT_HOOK_SPECS.pi

  test('shim injects -e with the in-process extension file', () => {
    expect(spec.shim!.args(ctx)).toEqual(['-e', ctx.filePath])
    const src = spec.shim!.file!.content()
    // The extension posts identity from ctx.sessionManager and echoes the env.
    expect(src).toContain('getSessionId')
    expect(src).toContain('CATE_TERMINAL_ID')
    for (const ev of ['session_start', 'agent_start', 'agent_end', 'session_shutdown']) {
      expect(src).toContain(ev)
    }
  })

  test('normalizes the extension-posted lifecycle', () => {
    const base = {
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      sessionFile: '/home/u/.pi/agent/sessions/slug/aaaa.jsonl',
      cwd: '/w',
    }
    expect(norm('pi', { event: 'session_start', ...base })).toMatchObject({
      kind: 'session-start',
      sessionId: base.sessionId,
      transcriptPath: base.sessionFile,
      cwd: '/w',
    })
    expect(norm('pi', { event: 'agent_start', ...base })?.kind).toBe('turn-start')
    expect(norm('pi', { event: 'agent_end', ...base })?.kind).toBe('turn-end')
    expect(norm('pi', { event: 'session_shutdown', ...base })?.kind).toBe('session-end')
    expect(norm('pi', { event: 'turn_start', ...base })).toBeNull()
  })
})

describe('opencode spec', () => {
  const spec = AGENT_HOOK_SPECS.opencode

  test('env injection merges a plugin entry via OPENCODE_CONFIG_CONTENT', () => {
    const vars = spec.env!.vars(ctx)
    const config = JSON.parse(vars.OPENCODE_CONFIG_CONTENT) as { plugin: string[] }
    expect(config.plugin).toEqual([`file://${ctx.filePath}`])
    // Only the plugin key: the config-content merge rides ON TOP of the user's
    // config, so anything else here would override user settings.
    expect(Object.keys(config)).toEqual(['plugin'])
  })

  test('normalizes bus events; busy status starts the turn, idle event ends it', () => {
    expect(norm('opencode', { type: 'session.created', sessionID: 'ses_1', directory: '/w' })).toMatchObject({
      kind: 'session-start',
      sessionId: 'ses_1',
      cwd: '/w',
    })
    expect(norm('opencode', { type: 'session.status', sessionID: 'ses_1', status: { type: 'busy' } })?.kind).toBe('turn-start')
    // The idle STATUS is redundant with the explicit session.idle event.
    expect(norm('opencode', { type: 'session.status', sessionID: 'ses_1', status: { type: 'idle' } })).toBeNull()
    expect(norm('opencode', { type: 'session.idle', sessionID: 'ses_1' })?.kind).toBe('turn-end')
    const asked = norm('opencode', {
      type: 'permission.asked',
      sessionID: 'ses_1',
      permission: 'bash',
      metadata: { command: 'touch needs-approval.txt' },
    })
    expect(asked?.kind).toBe('permission-wait')
    expect(asked?.raw.metadata).toMatchObject({ command: 'touch needs-approval.txt' })
    // Any reply resumes the turn — even a rejection (the model receives the
    // denial and the turn runs on to its own end), so the plugin doesn't
    // forward the reply value at all.
    expect(norm('opencode', { type: 'permission.replied', sessionID: 'ses_1' })?.kind).toBe('turn-resume')
    expect(spec.env!.file.content()).toContain('permission.replied')
  })
})

describe('cursor spec', () => {
  const spec = AGENT_HOOK_SPECS.cursor
  const file = spec.projectFiles![0]

  test('creates .cursor/hooks.json when absent', () => {
    expect(file.relPath).toBe('.cursor/hooks.json')
    const out = file.build(null, ctx)!
    const parsed = JSON.parse(out) as { version: number; hooks: Record<string, Array<{ command: string }>> }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.hooks).sort()).toEqual(['beforeSubmitPrompt', 'sessionEnd', 'sessionStart', 'stop'].sort())
    for (const handlers of Object.values(parsed.hooks)) expect(handlers[0].command).toBe(ctx.bridgeCommand)
  })

  test('merges into an existing user file: user handlers kept, stale Cate entries refreshed', () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        sessionStart: [
          { command: '/home/u/my-own-hook.sh' },
          { command: `/old-boot-dir/${CATE_HOOK_MARKER}-bridge-cursor` }, // stale ours
        ],
      },
      userField: true,
    })
    const out = file.build(existing, ctx)!
    const parsed = JSON.parse(out) as { hooks: Record<string, Array<{ command: string }>>; userField: boolean }
    expect(parsed.userField).toBe(true)
    const commands = parsed.hooks.sessionStart.map((h) => h.command)
    expect(commands).toContain('/home/u/my-own-hook.sh')
    expect(commands).toContain(ctx.bridgeCommand)
    expect(commands).not.toContain(`/old-boot-dir/${CATE_HOOK_MARKER}-bridge-cursor`)
    // Every tracked event gained our handler.
    expect(parsed.hooks.stop.map((h) => h.command)).toContain(ctx.bridgeCommand)
  })

  test('leaves an unparseable user file alone; identical rewrite is a no-op', () => {
    expect(file.build('{not json', ctx)).toBeNull()
    const fresh = file.build(null, ctx)!
    expect(file.build(fresh, ctx)).toBeNull()
  })

  test('normalizes conversation events', () => {
    const id = '12121212-3434-4545-8767-989898989898'
    expect(norm('cursor', { hook_event_name: 'sessionStart', conversation_id: id })).toMatchObject({
      kind: 'session-start',
      sessionId: id,
    })
    expect(norm('cursor', { hook_event_name: 'beforeSubmitPrompt', conversation_id: id })?.kind).toBe('turn-start')
    expect(norm('cursor', { hook_event_name: 'stop', conversation_id: id, status: 'completed' })?.kind).toBe('turn-end')
    expect(norm('cursor', { hook_event_name: 'sessionEnd', conversation_id: id })?.kind).toBe('session-end')
    // afterAgentResponse is not registered, but a stray payload must drop.
    expect(norm('cursor', { hook_event_name: 'afterAgentResponse', conversation_id: id })).toBeNull()
  })
})

describe('agy spec', () => {
  const spec = AGENT_HOOK_SPECS.antigravity
  const file = spec.projectFiles![0]

  test('creates .agents/hooks.json with only the safe PreInvocation/Stop hooks', () => {
    expect(file.relPath).toBe('.agents/hooks.json')
    const parsed = JSON.parse(file.build(null, ctx)!) as Record<string, Record<string, Array<{ command: string }>>>
    const ours = parsed['cate-hook-bridge']
    // ONLY PreInvocation/Stop — an observing PreToolUse would DENY tool calls.
    expect(Object.keys(ours).sort()).toEqual(['PreInvocation', 'Stop'])
    expect(ours.Stop[0].command).toBe(ctx.bridgeCommand)
  })

  test('merges under our named key, preserving user hooks; unparseable is left alone', () => {
    const existing = JSON.stringify({ 'user-hook': { Stop: [{ type: 'command', command: '/u/x.sh' }] } })
    const parsed = JSON.parse(file.build(existing, ctx)!) as Record<string, unknown>
    expect(parsed['user-hook']).toEqual({ Stop: [{ type: 'command', command: '/u/x.sh' }] })
    expect(parsed['cate-hook-bridge']).toBeTruthy()
    expect(file.build('][', ctx)).toBeNull()
    const fresh = file.build(null, ctx)!
    expect(file.build(fresh, ctx)).toBeNull()
  })

  test('trust seeding adds the workspace once and preserves other settings', () => {
    const t = spec.trust!
    expect(t.relPath).toBe('.gemini/antigravity-cli/settings.json')
    const first = t.build(JSON.stringify({ theme: 'dark' }), '/w')!
    const parsed = JSON.parse(first) as { theme: string; trustedWorkspaces: string[] }
    expect(parsed.theme).toBe('dark')
    expect(parsed.trustedWorkspaces).toEqual(['/w'])
    // Already trusted → no rewrite; unparseable → left alone.
    expect(t.build(first, '/w')).toBeNull()
    expect(t.build('nope{', '/w')).toBeNull()
    // Absent file → created with just the trust list.
    expect(JSON.parse(t.build(null, '/w')!)).toEqual({ trustedWorkspaces: ['/w'] })
  })

  test('normalizes by payload shape: terminationReason marks turn-end', () => {
    const id = 'abcdabcd-1234-4123-8123-abcdabcdabcd'
    expect(norm('antigravity', { conversationId: id })).toMatchObject({ kind: 'turn-start', sessionId: id })
    expect(norm('antigravity', { conversationId: id, terminationReason: 'STOP' })?.kind).toBe('turn-end')
    expect(norm('antigravity', { something: 'else' })).toBeNull()
  })
})

describe('normalizeAgentHookPayload', () => {
  test('unknown agents and untracked payloads drop; raw payload rides along', () => {
    expect(normalizeAgentHookPayload('not-an-agent', 't', { hook_event_name: 'Stop' })).toBeNull()
    const payload = { hook_event_name: 'Stop', session_id: 'sid', extra: { deep: true } }
    const event = normalizeAgentHookPayload('claude-code', 'term-9', payload)!
    expect(event.raw).toBe(payload)
    expect(event.terminalId).toBe('term-9')
  })
})
