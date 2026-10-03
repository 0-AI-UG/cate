import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelDefinition } from '@panels/definitions'
import type { ActivityScan, EnvContributor, LaunchResolver, SpawnInfo } from '@services/terminal/runtime'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { AGENT_DEFS, AGENT_LAUNCH, type AgentId, type AgentNotificationEvent, type TerminalResumeStamp } from '../../contract'
import { AGENT_SESSION_STORES, createAgentsRuntime, type AgentsDocument, type AgentsRuntime, type RelationContextMode } from '../../runtime'
import { createTerminalRunner, type RunnerTerminalService, type TerminalRunner } from './terminalRunner'

function fakeTerminal() {
  const contributors = new Set<EnvContributor>()
  const intents = new Map<string, LaunchResolver>()
  const inputs = new Set<(id: string, data: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const activity = new Set<(scan: ActivityScan) => void>()
  const writes: Array<{ id: string; data: string }> = []
  const add = <T>(set: Set<T>, value: T) => { set.add(value); return () => { set.delete(value) } }
  const service: RunnerTerminalService = {
    registerEnvContributor: (c) => add(contributors, c),
    registerLaunchIntent: (kind, resolver) => { intents.set(kind, resolver); return () => { intents.delete(kind) } },
    onInput: (o) => add(inputs, o),
    onExit: (o) => add(exits, o),
    onActivity: (o) => add(activity, o),
    write: (id, data) => { writes.push({ id, data }); for (const o of inputs) o(id, data) },
    cwd: async () => '/fallback-cwd',
    read: async () => ({ alt: false, text: '' }),
    statuses: () => ({}),
  }
  return {
    service,
    writes,
    intents,
    async spawn(info: Partial<SpawnInfo> & { terminalId: string; panelId: string; cwd: string }): Promise<Record<string, string>> {
      let env: Record<string, string> = { PATH: '/usr/bin' }
      for (const contribute of contributors) {
        const extra = await contribute({ launch: null, executable: '/bin/zsh', args: [], env, ...info })
        if (extra) env = { ...env, ...extra }
      }
      return env
    },
    scan(terminalId: string, panelId: string, processName?: string): void {
      for (const o of activity) {
        o({
          terminalId,
          panelId,
          pid: 1,
          activity: processName ? { type: 'running', processName } : { type: 'idle' },
          tree: procTree,
        })
      }
    },
    exit(terminalId: string, code: number): void {
      for (const o of exits) o(terminalId, code)
    },
  }
}

function fakeDocument(panels: PanelRecord[], relations: PanelRelation[] = []) {
  const modes = new Map<string, RelationContextMode>()
  const titles: Array<{ panelId: string; title: string }> = []
  const document: AgentsDocument = {
    panel: (id) => panels.find((panel) => panel.id === id),
    panels: () => panels,
    relations: () => relations,
    worktreePath: () => undefined,
    relationContextMode: (id) => modes.get(id) ?? 'once',
    setRelationContextMode: (id, mode) => { modes.set(id, mode) },
    setTitleFromAgent: (panelId, title) => { titles.push({ panelId, title }) },
    onChange: () => () => {},
  }
  return { document, modes, titles }
}

/** The process table both the scan and a hook post's pid lookup see. */
let procTree = { nameByPid: new Map<number, string>(), childrenByPid: new Map<number, number[]>() }
const dirs: string[] = []
const tmp = (name: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cate-terminal-runner-${name}-`))
  dirs.push(dir)
  return dir
}

let terminal: ReturnType<typeof fakeTerminal>
let doc: ReturnType<typeof fakeDocument>
let agents: AgentsRuntime
let runner: TerminalRunner
let notifications: AgentNotificationEvent[]
let root: string

async function post(env: Record<string, string>, agentId: string, payload: Record<string, unknown>, pid?: number): Promise<string> {
  const response = await fetch(`${env.CATE_HOOK_ENDPOINT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CATE_HOOK_TOKEN}` },
    body: JSON.stringify({ agentId, terminalId: env.CATE_TERMINAL_ID, pid, payload }),
  })
  return response.text()
}

beforeEach(() => {
  procTree = { nameByPid: new Map(), childrenByPid: new Map() }
  root = tmp('root')
  terminal = fakeTerminal()
  doc = fakeDocument([
    { id: 'term', type: 'terminal', title: 'Terminal', fields: {} },
    { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
  ], [{ id: 'r', fromPanelId: 'term', toPanelId: 'browser', kind: 'use' }])
  agents = createAgentsRuntime({
    root,
    agentsDir: tmp('agents'),
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { agentHookInjection: () => ({}), panelRelationsEnabled: () => true },
    relationRole: (type) => panelDefinition(type)?.relation,
    document: doc.document,
    resolveCheckout: async (cwd) => cwd ?? root,
    snapshot: async () => procTree,
    homeDir: tmp('home'),
    hookOptions: {
      titleRetryDelaysMs: [0],
      sessionStores: { ...AGENT_SESSION_STORES, 'claude-code': { title: async () => 'Fix login bug', conversation: async () => [{ role: 'user', text: 'hi' }] } },
    },
  })
  notifications = []
  agents.notifications.subscribe((event) => notifications.push(event))
  runner = createTerminalRunner(agents, terminal.service)
  agents.registry.register(runner)
})

afterEach(() => {
  runner.dispose()
  agents.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('terminal runner', () => {
  it('plants the hook env on spawn and tracks the agent from hooks and presence', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    expect(env.CATE_TERMINAL_ID).toBe('pty-1')
    expect(env.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(agents.registry.sessionFor('term')).toBeNull()

    terminal.scan('pty-1', 'term', 'claude')
    expect(agents.registry.sessionFor('term')).toMatchObject({ runner: 'terminal', present: true, status: 'notRunning', canReceivePrompt: false })

    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    expect(agents.registry.sessionFor('term')).toMatchObject({
      agentId: 'claude-code',
      agentName: 'Claude Code',
      status: 'running',
      canReceivePrompt: false,
      session: { agentId: 'claude-code', runner: 'terminal', sessionId: 'sess-1', cwd: root },
    })
    expect(agents.busy()).toEqual(['term'])

    await post(env, 'claude-code', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root })
    expect(agents.registry.sessionFor('term')).toMatchObject({ status: 'waitingForInput', canReceivePrompt: true })
    expect(notifications).toEqual([{ kind: 'agent.needsInput', panelId: 'term', title: 'Claude Code needs input', body: 'Claude Code is waiting for your response.' }])
  })

  it('publishes resume stamps as panel session state and clears them when the agent exits', async () => {
    const stamps: Array<{ panelId: string; stamp: TerminalResumeStamp | null }> = []
    runner.onResumeStamp((panelId, stamp) => stamps.push({ panelId, stamp }))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await post(env, 'codex', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root })
    expect(runner.resumeStamp('term')).toEqual({ agentId: 'codex', sessionId: 'sess-1', cwd: root })
    expect(runner.resumeLaunch(runner.resumeStamp('term')!)).toEqual({ kind: AGENT_LAUNCH.resume, params: runner.resumeStamp('term') })
    expect(await terminal.intents.get(AGENT_LAUNCH.resume)!(runner.resumeStamp('term'), { cwd: root, panelId: 'term' }))
      .toEqual({ input: 'codex resume sess-1' })
    expect(stamps).toEqual([{ panelId: 'term', stamp: { agentId: 'codex', sessionId: 'sess-1', cwd: root } }])
  })

  it('resolves a mission launch to the canonical argv', async () => {
    expect(await terminal.intents.get(AGENT_LAUNCH.mission)!({ agentId: 'opencode', prompt: 'Fix it' }, { cwd: root, panelId: 'w' }))
      .toEqual({ command: { executable: 'opencode', args: ['--prompt', 'Complete this coding task:\n\nFix it'] } })
    expect(() => terminal.intents.get(AGENT_LAUNCH.mission)!({ agentId: '/bin/sh', prompt: 'x' }, { cwd: root, panelId: 'w' })).toThrow()
  })

  it('sends a prompt only to an agent at its prompt, as a bracketed paste and Enter', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await expect(runner.send('term', 'hello')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
    terminal.scan('pty-1', 'term', 'claude')
    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    await expect(agents.send('term', 'hello')).resolves.toEqual({ ok: false, error: 'agent-busy' })
    await post(env, 'claude-code', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root })

    await expect(agents.send('term', 'line one\nline two')).resolves.toEqual({ ok: true })
    expect(terminal.writes).toEqual([
      { id: 'pty-1', data: '\x1b[200~line one\rline two\x1b[201~' },
      { id: 'pty-1', data: '\r' },
    ])
    // The send consumed the one-shot relation context.
    expect(doc.modes.get('term')).toBe('off')
  })

  it('answers a native submit hook with the relation context and disarms a one-shot context', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    const output = await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain('Browser')
    expect(doc.modes.get('term')).toBe('off')
  })

  it('applies the agent session title to the panel and reads its conversation', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    await vi.waitFor(() => expect(doc.titles).toEqual([{ panelId: 'term', title: 'Fix login bug' }]))
    await expect(runner.conversation('term')).resolves.toEqual({
      session: { agentId: 'claude-code', runner: 'terminal', sessionId: 'sess-1', cwd: root },
      messages: [{ role: 'user', text: 'hi' }],
    })
  })

  it('forgets the terminal when its PTY exits and reports the exit per panel', async () => {
    const exits: Array<[string, number]> = []
    runner.onExit((panelId, code) => exits.push([panelId, code]))
    const changes = vi.fn()
    agents.registry.subscribe(changes)
    await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.scan('pty-1', 'term', 'claude')
    expect(agents.registry.sessionFor('term')).not.toBeNull()
    terminal.exit('pty-1', 0)
    expect(exits).toEqual([['term', 0]])
    expect(runner.terminalOf('term')).toBeNull()
    expect(agents.registry.sessionFor('term')).toBeNull()
    expect(changes).toHaveBeenLastCalledWith({ term: null })
  })
})

// PTY input and agent hooks share one ordered status stream.
describe('terminal runner input and hook ordering', () => {
  const fixtures = [
    { agentId: 'codex', start: { hook_event_name: 'UserPromptSubmit' }, wait: { hook_event_name: 'PermissionRequest' } },
    { agentId: 'claude-code', start: { hook_event_name: 'UserPromptSubmit' }, wait: { hook_event_name: 'PermissionRequest' } },
    { agentId: 'grok', start: { hookEventName: 'user_prompt_submit' }, wait: { hookEventName: 'notification', notificationType: 'permission_prompt' } },
    { agentId: 'hermes', start: { hook_event_name: 'pre_llm_call', platform: 'cli' }, wait: { hook_event_name: 'pre_approval_request', platform: 'cli', surface: 'cli' } },
    { agentId: 'opencode', start: { type: 'session.status', status: { type: 'busy' } }, wait: { type: 'permission.asked' } },
    // These CLIs have no permission-wait hook. Input must preserve their running state.
    { agentId: 'cursor', start: { hook_event_name: 'beforeSubmitPrompt' }, wait: null },
    { agentId: 'kiro', start: { hook_event_name: 'UserPromptSubmit' }, wait: null },
  ] as const
  const ids = { session_id: 'session', sessionId: 'session', sessionID: 'session' }
  const status = () => agents.registry.sessionFor('term')?.status

  // The agent process a hook post names: presence registers it from the post.
  const AGENT_PID = 4242
  async function setup() {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    return async (agentId: AgentId, payload: Record<string, unknown>) => {
      procTree.nameByPid.set(AGENT_PID, AGENT_DEFS[agentId].runners.terminal.command)
      const output = await post(env, agentId, { ...ids, ...payload }, AGENT_PID)
      terminal.scan('pty-1', 'term', 'node')
      return output
    }
  }

  it('covers every CLI agent', async () => {
    const { AGENTS } = await import('../../contract')
    expect(fixtures.map((f) => f.agentId).sort()).toEqual(AGENTS.map((a) => a.id).sort())
  })

  it.each(fixtures)('$agentId stays running after an approval answered at the terminal', async ({ agentId, start, wait }) => {
    const send = await setup()
    await send(agentId, start)
    expect(status()).toBe('running')
    if (wait) {
      await send(agentId, wait)
      // Codex and Claude PermissionRequest is a check (an automatic reviewer
      // may answer it), so the turn keeps running.
      expect(status()).toBe(agentId === 'codex' || agentId === 'claude-code' ? 'running' : 'waitingForInput')
    }
    terminal.service.write('pty-1', '\r')
    expect(status()).toBe('running')
    terminal.scan('pty-1', 'term', 'node')
    expect(status()).toBe('running') // no PostToolUse; the command still runs
  })

  it('does not resume for typing or navigation', async () => {
    const send = await setup()
    await send('codex', { hook_event_name: 'UserPromptSubmit' })
    await send('codex', { hook_event_name: 'PermissionRequest' })
    terminal.service.write('pty-1', 'some text')
    terminal.service.write('pty-1', '\x1b[B')
    expect(status()).toBe('running')
  })

  it('an Enter in an idle agent stays idle', async () => {
    const send = await setup()
    await send('codex', { hook_event_name: 'SessionStart' })
    terminal.service.write('pty-1', 'private input\r')
    expect(status()).toBe('waitingForInput')
  })

  it('a reused terminal id must prove its agent again', async () => {
    const send = await setup()
    await send('codex', { hook_event_name: 'UserPromptSubmit' })
    terminal.exit('pty-1', 0)
    await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.service.write('pty-1', '\r')
    expect(agents.registry.sessionFor('term')).toBeNull()
  })

  it('recovers a Kiro Ctrl-C interrupt from PTY input', async () => {
    const send = await setup()
    await send('kiro', { hook_event_name: 'UserPromptSubmit' })
    expect(status()).toBe('running')
    terminal.service.write('pty-1', '\x03')
    expect(status()).toBe('waitingForInput')
    expect(notifications).toEqual([]) // a recovered interrupt is silent
  })
})
