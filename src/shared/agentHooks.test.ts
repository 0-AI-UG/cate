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
  type HookInjectionContext,
} from './agentHooks'

const ctx: HookInjectionContext = {
  bridgeCommand: '/cate/hooks/cate-hook-bridge-x',
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
  const file = spec.projectFiles![0]

  test('creates .codex/hooks.json with the bridge + timeout on all five events', () => {
    expect(file.relPath).toBe('.codex/hooks.json')
    const parsed = JSON.parse(file.build(null, ctx)!) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>
    }
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['PermissionRequest', 'PostToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
    )
    for (const groups of Object.values(parsed.hooks)) {
      expect(groups).toEqual([{ hooks: [{ type: 'command', command: ctx.bridgeCommand, timeout: 60 }] }])
    }
  })

  test('merges into an existing hooks.json: user hooks/fields kept, stale Cate groups refreshed', () => {
    const existing = JSON.stringify({
      notifications: true, // a foreign top-level field survives
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: '/home/u/my-codex-hook.sh', timeout: 5 }] },
          { hooks: [{ type: 'command', command: `/old-boot-dir/${CATE_HOOK_MARKER}-bridge-codex`, timeout: 60 }] },
        ],
      },
    })
    const out = file.build(existing, ctx)!
    const parsed = JSON.parse(out) as {
      notifications: unknown
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(parsed.notifications).toBe(true)
    const stopCommands = parsed.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command))
    expect(stopCommands).toContain('/home/u/my-codex-hook.sh')
    expect(stopCommands).toContain(ctx.bridgeCommand)
    expect(stopCommands).not.toContain(`/old-boot-dir/${CATE_HOOK_MARKER}-bridge-codex`)
    // Every tracked event gained our group.
    expect(parsed.hooks.PermissionRequest.flatMap((g) => g.hooks.map((h) => h.command))).toContain(ctx.bridgeCommand)
  })

  test('a "hooks": [] value is replaced, never silently swallowed', () => {
    // [] passes typeof-object checks, and named keys assigned onto an array
    // vanish in JSON.stringify — this exact bug shipped in the old cursor
    // merge. The guard must rebuild hooks as a real object.
    const out = file.build(JSON.stringify({ hooks: [] }), ctx)!
    const parsed = JSON.parse(out) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(Array.isArray(parsed.hooks)).toBe(false)
    expect(parsed.hooks.SessionStart[0].hooks[0].command).toBe(ctx.bridgeCommand)
  })

  test('leaves an unparseable hooks.json alone; identical rewrite is a no-op', () => {
    expect(file.build('{not json', ctx)).toBeNull()
    const fresh = file.build(null, ctx)!
    expect(file.build(fresh, ctx)).toBeNull()
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

describe('cursor spec', () => {
  const spec = AGENT_HOOK_SPECS.cursor
  const file = spec.projectFiles![0]
  // Field set mirrors the live-captured payloads (cursor-agent 2026.07.16):
  // session_id === conversation_id, cwd rides in workspace_roots (the payload
  // `cwd` field is often ""), transcript_path null until the first tool/turn.
  const base = {
    conversation_id: 'abcdefab-1111-4222-8333-444444444444',
    generation_id: 'abcdefab-1111-4222-8333-444444444444',
    session_id: 'abcdefab-1111-4222-8333-444444444444',
    model: 'composer-2.5',
    cursor_version: '2026.07.16-899851b',
    workspace_roots: ['/w'],
    user_email: 'u@example.com',
    transcript_path: '/home/u/.cursor/projects/slug/agent-transcripts/abcd/abcd.jsonl',
  }

  test('creates .cursor/hooks.json (version 1, flat [{command}] handlers) on all five events', () => {
    expect(file.relPath).toBe('.cursor/hooks.json')
    const parsed = JSON.parse(file.build(null, ctx)!) as {
      version: number
      hooks: Record<string, Array<{ command: string }>>
    }
    expect(parsed.version).toBe(1)
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['beforeSubmitPrompt', 'postToolUse', 'sessionEnd', 'sessionStart', 'stop'].sort(),
    )
    for (const handlers of Object.values(parsed.hooks)) {
      expect(handlers).toEqual([{ command: ctx.bridgeCommand }])
    }
  })

  test('merges into an existing hooks.json: user hooks/fields kept, stale Cate entries refreshed', () => {
    const existing = JSON.stringify({
      version: 1,
      hooks: {
        stop: [
          { command: '/home/u/my-stop-hook.sh' },
          { command: `/old-boot-dir/${CATE_HOOK_MARKER}-bridge-cursor` },
        ],
        // A user event Cate doesn't track survives untouched.
        beforeShellExecution: [{ command: '/home/u/audit.sh' }],
      },
    })
    const out = file.build(existing, ctx)!
    const parsed = JSON.parse(out) as { version: number; hooks: Record<string, Array<{ command: string }>> }
    expect(parsed.version).toBe(1)
    const stopCommands = parsed.hooks.stop.map((h) => h.command)
    expect(stopCommands).toContain('/home/u/my-stop-hook.sh')
    expect(stopCommands).toContain(ctx.bridgeCommand)
    expect(stopCommands).not.toContain(`/old-boot-dir/${CATE_HOOK_MARKER}-bridge-cursor`)
    expect(parsed.hooks.beforeShellExecution).toEqual([{ command: '/home/u/audit.sh' }])
    expect(parsed.hooks.sessionStart.map((h) => h.command)).toContain(ctx.bridgeCommand)
  })

  test('a "hooks": [] value is replaced, never silently swallowed', () => {
    // The exact bug the OLD cursor merge shipped: [] passes typeof-object,
    // and named keys assigned onto an array vanish in JSON.stringify.
    const out = file.build(JSON.stringify({ version: 1, hooks: [] }), ctx)!
    const parsed = JSON.parse(out) as { hooks: Record<string, Array<{ command: string }>> }
    expect(Array.isArray(parsed.hooks)).toBe(false)
    expect(parsed.hooks.sessionStart[0].command).toBe(ctx.bridgeCommand)
  })

  test('leaves an unparseable hooks.json alone; identical rewrite is a no-op', () => {
    expect(file.build('{not json', ctx)).toBeNull()
    const fresh = file.build(null, ctx)!
    expect(file.build(fresh, ctx)).toBeNull()
  })

  test('lifecycle events normalize; cwd comes from workspace_roots', () => {
    const start = norm('cursor', {
      hook_event_name: 'sessionStart',
      ...base,
      transcript_path: null, // null until the first tool/turn event
      is_background_agent: false,
    })
    expect(start).toMatchObject({
      agentId: 'cursor',
      kind: 'session-start',
      sessionId: base.session_id,
      cwd: '/w',
    })
    expect(start?.transcriptPath).toBeUndefined()
    expect(norm('cursor', { hook_event_name: 'beforeSubmitPrompt', prompt: 'hi', attachments: [], ...base })).toMatchObject(
      { kind: 'turn-start', transcriptPath: base.transcript_path },
    )
    expect(
      norm('cursor', { hook_event_name: 'postToolUse', tool_name: 'Shell', tool_input: {}, duration: 1, ...base })?.kind,
    ).toBe('turn-resume')
    expect(norm('cursor', { hook_event_name: 'stop', status: 'completed', loop_count: 0, ...base })?.kind).toBe('turn-end')
    // Abort fires stop too (status "aborted", occasionally a second "error"
    // stop) — same turn-end either way.
    expect(norm('cursor', { hook_event_name: 'stop', status: 'aborted', loop_count: 0, ...base })?.kind).toBe('turn-end')
    expect(
      norm('cursor', { hook_event_name: 'sessionEnd', reason: 'completed', final_status: 'completed', ...base })?.kind,
    ).toBe('session-end')
  })

  test('untracked events drop — beforeShellExecution is NOT a permission signal', () => {
    // It fires before EVERY shell command (auto-approved or prompted alike),
    // so mapping it to permission-wait would notify on every tool call.
    expect(
      norm('cursor', { hook_event_name: 'beforeShellExecution', command: 'echo x', sandbox: false, ...base }),
    ).toBeNull()
    expect(norm('cursor', { hook_event_name: 'preToolUse', tool_name: 'Shell', ...base })).toBeNull()
  })

  test('falls back to conversation_id when session_id is absent', () => {
    const { session_id: _dropped, ...noSession } = base
    expect(norm('cursor', { hook_event_name: 'stop', status: 'completed', ...noSession })?.sessionId).toBe(
      base.conversation_id,
    )
  })
})

describe('pi spec', () => {
  const spec = AGENT_HOOK_SPECS.pi
  const file = spec.projectFiles![0]

  test('owns .pi/extensions/cate-hook.ts outright: created when absent, rewritten on any drift', () => {
    expect(file.relPath).toBe('.pi/extensions/cate-hook.ts')
    const src = file.build(null, ctx)!
    // Marker in the header — prepareWorkspace re-recognizes the file as ours.
    expect(src).toContain(CATE_HOOK_MARKER)
    // The extension posts identity from ctx.sessionManager, echoes the env,
    // and self-gates on the Cate env vars (inert in a teammate's checkout).
    expect(src).toContain('getSessionId')
    expect(src).toContain('CATE_TERMINAL_ID')
    expect(src).toContain('CATE_HOOK_ENDPOINT')
    for (const ev of ['session_start', 'agent_start', 'agent_end', 'session_shutdown']) {
      expect(src).toContain(ev)
    }
    // Content is boot-independent: up-to-date file untouched, ANY drift
    // (even a user edit — Cate owns this file) rewritten.
    expect(file.build(src, ctx)).toBeNull()
    expect(file.build('// user-edited\n' + src, ctx)).toBe(src)
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

describe('grok spec', () => {
  const spec = AGENT_HOOK_SPECS.grok
  const file = spec.projectFiles![0]
  // Field-for-field the live payload shape (agentHookContracts.itest.ts):
  // camelCase envelope, snake_case event value.
  const base = {
    sessionId: '019f8441-15a5-79f2-ae8c-8ad1021a9e18',
    cwd: '/home/u/proj',
    workspaceRoot: '/home/u/proj',
    transcriptPath: '/home/u/.grok/sessions/%2Fhome%2Fu%2Fproj/019f8441/updates.jsonl',
  }

  test('owns .grok/hooks/cate.json: created with the bridge + timeout on all six events', () => {
    // One file of its own in a directory grok merges — a user's other hook
    // files in .grok/hooks/ are never touched.
    expect(file.relPath).toBe('.grok/hooks/cate-hook.json')
    const parsed = JSON.parse(file.build(null, ctx)!) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string; timeout: number }> }>>
    }
    // File keys are CamelCase even though the payload reports snake_case.
    expect(Object.keys(parsed.hooks).sort()).toEqual(
      ['Notification', 'PostToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit'],
    )
    for (const groups of Object.values(parsed.hooks)) {
      expect(groups[0].hooks[0]).toEqual({ type: 'command', command: ctx.bridgeCommand, timeout: 60 })
    }
    // PreToolUse is deliberately absent: it fires before EVERY tool call, so
    // it cannot mark a permission wait (Notification does that).
    expect(parsed.hooks.PreToolUse).toBeUndefined()
  })

  test('reclaims a drifted file but leaves a same-named user file alone', () => {
    const ours = file.build(null, ctx)!
    expect(file.build(ours, ctx)).toBeNull() // up to date — no rewrite
    expect(file.strip!(ours)).toEqual({ delete: true })
    // No marker = not ours (a user's own cate-hook.json): never deleted.
    expect(file.strip!('{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"mine.sh"}]}]}}')).toBeNull()
  })

  test('lifecycle events normalize with identity fields', () => {
    expect(norm('grok', { hookEventName: 'session_start', ...base, source: 'new' })).toMatchObject({
      kind: 'session-start',
      sessionId: base.sessionId,
      cwd: '/home/u/proj',
      transcriptPath: base.transcriptPath,
    })
    expect(norm('grok', { hookEventName: 'user_prompt_submit', ...base })?.kind).toBe('turn-start')
    expect(norm('grok', { hookEventName: 'stop', ...base })?.kind).toBe('turn-end')
    expect(norm('grok', { hookEventName: 'session_end', ...base })?.kind).toBe('session-end')
    // Approval resolution / any executed tool call.
    expect(norm('grok', { hookEventName: 'post_tool_use', ...base, toolName: 'run_terminal_command' })?.kind)
      .toBe('turn-resume')
  })

  test('session_start carries no transcriptPath — the field stays optional', () => {
    const { transcriptPath, ...noTranscript } = base
    expect(norm('grok', { hookEventName: 'session_start', ...noTranscript })).toMatchObject({
      kind: 'session-start',
      sessionId: base.sessionId,
      transcriptPath: undefined,
    })
  })

  test('Notification maps permission_prompt to permission-wait and drops other types', () => {
    expect(
      norm('grok', {
        hookEventName: 'notification',
        ...base,
        notificationType: 'permission_prompt',
        message: 'Tool permission requested',
      })?.kind,
    ).toBe('permission-wait')
    expect(norm('grok', { hookEventName: 'notification', ...base, notificationType: 'turn_complete' })).toBeNull()
  })

  test('claude-shaped and untracked payloads drop', () => {
    // The snake_case envelope is CLAUDE's, not grok's — a payload that reached
    // the grok normalizer in that shape is not a grok event.
    expect(norm('grok', { hook_event_name: 'SessionStart', session_id: 'x' })).toBeNull()
    expect(norm('grok', { hookEventName: 'SessionStart', ...base })).toBeNull() // CamelCase is the FILE casing
    expect(norm('grok', { hookEventName: 'pre_tool_use', ...base })).toBeNull()
    expect(norm('grok', { hookEventName: 'permission_denied', ...base })).toBeNull()
  })
})

describe('opencode spec', () => {
  const spec = AGENT_HOOK_SPECS.opencode

  test('the plugin lands where opencode scans, and Cate owns it outright', () => {
    const pf = spec.projectFiles![0]
    // opencode scans `{plugin,plugins}/*.{ts,js}` under its config dirs — .mjs
    // would never be picked up.
    expect(pf.relPath).toBe('.opencode/plugin/cate-hook.js')

    const source = pf.build(null, ctx)!
    // Cate owns the file outright: marked, never rewritten when current,
    // reclaimed on 'off', and a same-named user file is left alone.
    expect(source).toContain(CATE_HOOK_MARKER)
    expect(pf.build(source, ctx)).toBeNull()
    expect(pf.strip!(source)).toEqual({ delete: true })
    expect(pf.strip!('// my own plugin\n')).toBeNull()
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
    expect(spec.projectFiles![0].build(null, ctx)).toContain('permission.replied')
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
