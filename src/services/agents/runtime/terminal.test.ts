import fs, { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { panelDefinition } from '@panels/definitions'
import { createTerminalService, type ActivityScan, type EnvContributor, type LaunchResolver, type PtyProcess, type PtySpawner, type SpawnInfo } from '@services/terminal/runtime'
import { createLogger } from '@kernel/log/contract'
import type { PanelRecord, PanelRelation } from '@workspace/document/contract'
import { TERMINAL_RESTORE_LAUNCH } from '@services/terminal/contract'
import { AGENT_DEFS, AGENT_LAUNCH, type AgentId, type AgentStep } from '../contract'
import { createAgentsCore, type AgentsCore } from './core'
import type { AgentsDocument } from './promptContext'
import type { RelationContextMode } from '@workspace/relations/contract'
import { AGENT_SESSION_STORES } from './sessions'
import { createTerminalAgents, type AgentTerminalService, type TerminalAgents } from './terminal'
import type { NotificationEvent } from '@workspace/notifications/contract'


function fakeTerminal() {
  const contributors = new Set<EnvContributor>()
  const intents = new Map<string, LaunchResolver>()
  const inputs = new Set<(id: string, data: string) => void>()
  const exits = new Set<(id: string, code: number) => void>()
  const activity = new Set<(scan: ActivityScan) => void>()
  const writes: Array<{ id: string; data: string }> = []
  const add = <T>(set: Set<T>, value: T) => { set.add(value); return () => { set.delete(value) } }
  const service: AgentTerminalService = {
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
    setRelationContextMode: (id, mode) => {
      modes.set(id, mode)
      const record = panels.find((panel) => panel.id === id)
      if (record) record.fields = { ...record.fields, relationContextMode: mode }
    },
    setTitleFromAgent: (panelId, title) => { titles.push({ panelId, title }) },
    onChange: () => () => {},
  }
  /** Patches a panel record, as a document op would. */
  const set = (id: string, patch: Partial<PanelRecord>) => {
    const index = panels.findIndex((panel) => panel.id === id)
    panels[index] = { ...panels[index], ...patch }
  }
  return { document, modes, titles, set }
}

/** The process table both the scan and a hook post's pid lookup see. */
let procTree = { nameByPid: new Map<number, string>(), childrenByPid: new Map<number, number[]>() }
const dirs: string[] = []
const tmp = (name: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `cate-terminal-agents-${name}-`))
  dirs.push(dir)
  return dir
}

let terminal: ReturnType<typeof fakeTerminal>
let doc: ReturnType<typeof fakeDocument>
let agents: AgentsCore
let agentTerminals: TerminalAgents
let notifications: NotificationEvent[]
let root: string
let stampsFile: string
let hookConfig: Partial<Record<AgentId, 'auto' | 'on' | 'off'>>

async function post(env: Record<string, string>, agentId: string, payload: Record<string, unknown>, pid?: number): Promise<string> {
  const response = await fetch(`${env.CATE_HOOK_ENDPOINT}/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.CATE_HOOK_TOKEN}` },
    body: JSON.stringify({ agentId, terminalId: env.CATE_TERMINAL_ID, pid, payload }),
  })
  return response.text()
}

beforeEach(() => {
  notifications = []
  procTree = { nameByPid: new Map(), childrenByPid: new Map() }
  hookConfig = {}
  root = tmp('root')
  stampsFile = path.join(tmp('agents-stamps'), 'stamps.json')
  terminal = fakeTerminal()
  doc = fakeDocument([
    { id: 'term', type: 'terminal', title: 'Terminal', fields: {} },
    { id: 'browser', type: 'browser', title: 'Browser', fields: {} },
  ], [{ id: 'r', fromPanelId: 'term', toPanelId: 'browser', kind: 'use' }])
  agents = createAgentsCore({
    root,
    agentsDir: tmp('agents'),
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { agentHookInjection: () => hookConfig, panelRelationsEnabled: () => true, usagePriceOverrides: () => ({}) },
    relationRole: (type) => panelDefinition(type)?.relation,
    document: doc.document,
    resolveCheckout: async (cwd) => cwd ?? root,
    snapshot: async () => procTree,
    notify: (event) => { notifications.push(event) },
    homeDir: tmp('home'),
    hookOptions: {
      titleRetryDelaysMs: [0],
      sessionStores: { ...AGENT_SESSION_STORES, 'claude-code': { ...AGENT_SESSION_STORES['claude-code'], title: async () => 'Fix login bug', conversation: async () => [{ role: 'user', text: 'hi' }] } },
    },
  }, (base) => agentTerminals = createTerminalAgents(base, terminal.service, { stampsFile }))
})

afterEach(() => {
  agentTerminals.dispose()
  agents.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('terminal agents', () => {
  it('plants the hook env on spawn and tracks the agent from hooks and presence', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    expect(env.CATE_TERMINAL_ID).toBe('pty-1')
    expect(env.CATE_HOOK_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(agents.panels.state('term')).toBeNull()

    terminal.scan('pty-1', 'term', 'claude')
    expect(agents.panels.state('term')).toMatchObject({ present: true, status: 'notRunning', canReceivePrompt: false })

    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    expect(agents.panels.state('term')).toMatchObject({
      agentId: 'claude-code',
      agentName: 'Claude Code',
      status: 'running',
      canReceivePrompt: false,
      session: { agentId: 'claude-code', sessionId: 'sess-1', cwd: root },
    })
    expect(agents.busy()).toEqual(['term'])

    await post(env, 'claude-code', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root })
    expect(agents.panels.state('term')).toMatchObject({ status: 'waitingForInput', canReceivePrompt: true })
    expect(notifications).toEqual([{ kind: 'agent.needsInput', panelId: 'term', title: 'Claude Code needs input', body: 'Claude Code is waiting for your response.' }])
  })

  it('a hook post that registers the agent pid makes it present before any scan', async () => {
    // A started agent's fast first turn: every hook lands before the first
    // activity scan. The bridge (4243) posts; its parent is the agent.
    procTree.nameByPid.set(4242, 'claude')
    procTree.nameByPid.set(4243, 'sh')
    procTree.childrenByPid.set(4242, [4243])
    const changes: unknown[] = []
    agents.panels.subscribe((change) => changes.push(change.term?.status ?? null))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })

    await post(env, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root }, 4243)
    expect(agents.panels.state('term')).toMatchObject({ present: true, status: 'waitingForInput' })
    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root }, 4243)
    expect(agents.panels.state('term')).toMatchObject({ present: true, status: 'running', canReceivePrompt: false })
    await post(env, 'claude-code', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root }, 4243)
    expect(agents.panels.state('term')).toMatchObject({ present: true, status: 'waitingForInput', canReceivePrompt: true })
    expect(changes.filter((status, i) => status !== changes[i - 1])).toEqual(['waitingForInput', 'running', 'waitingForInput'])

    // The falling edge still comes from a scan.
    procTree.nameByPid.set(4242, 'zsh')
    terminal.scan('pty-1', 'term')
    expect(agents.panels.state('term')).toMatchObject({ present: false, status: 'finished' })
  })

  it('persists a terminal panel\'s resume stamp and types it back when the panel is restored', async () => {
    const restore = () => terminal.intents.get(TERMINAL_RESTORE_LAUNCH.kind)!(undefined, { cwd: root, panelId: 'term' })
    expect(await restore()).toEqual({})
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await post(env, 'codex', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root })
    expect(await restore()).toEqual({ input: 'codex resume sess-1' })

    // After a runtime restart, from the file.
    agentTerminals.dispose()
    agentTerminals = createTerminalAgents(agents, terminal.service, { stampsFile })
    expect(JSON.parse(fs.readFileSync(stampsFile, 'utf8')).term).toMatchObject({ agentId: 'codex', sessionId: 'sess-1' })
    expect(await restore()).toEqual({ input: 'codex resume sess-1' })

    // A panel moved to another checkout does not resume the old session.
    doc.set('term', { worktreeId: 'wt-1' })
    expect(await restore()).toEqual({})
  })

  it('resolves a start launch to the canonical argv', async () => {
    expect(await terminal.intents.get(AGENT_LAUNCH.start)!({ agentId: 'opencode', prompt: 'Fix it' }, { cwd: root, panelId: 'w' }))
      .toEqual({ command: { executable: 'opencode', args: ['--prompt', 'Complete this coding task:\n\nFix it'] } })
    expect(() => terminal.intents.get(AGENT_LAUNCH.start)!({ agentId: '/bin/sh', prompt: 'x' }, { cwd: root, panelId: 'w' })).toThrow()
  })

  it('sends a prompt only to an agent at its prompt, as a bracketed paste and Enter', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await expect(agentTerminals.send('term', 'hello')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
    terminal.scan('pty-1', 'term', 'claude')
    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    await expect(agents.send('term', 'hello')).resolves.toEqual({ ok: false, error: 'agent-busy' })
    await post(env, 'claude-code', { hook_event_name: 'Stop', session_id: 'sess-1', cwd: root })
    // The first turn took the one-shot context; arm it again for the send.
    doc.document.setRelationContextMode('term', 'once')
    doc.modes.delete('term')

    const sent = agents.send('term', 'line one\nline two')
    await vi.waitFor(() => expect(terminal.writes).toEqual([
      { id: 'pty-1', data: '\x1b[200~line one\rline two\x1b[201~' },
      { id: 'pty-1', data: '\r' },
    ]))
    // The agent's submit hook takes the one-shot relation context, and its
    // turn-start disarms it and confirms the send.
    expect(doc.modes.get('term')).toBeUndefined()
    const output = await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain('Browser')
    expect(doc.modes.get('term')).toBe('off')
    await expect(sent).resolves.toEqual({ ok: true })
  })

  it('fails a send whose prompt starts no turn (a dialog took the Enter)', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.scan('pty-1', 'term', 'claude')
    await post(env, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sent = agents.send('term', 'hello')
      await vi.waitFor(() => expect(terminal.writes).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(sent).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/^agent-prompt-not-taken/) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait for a turn after a slash command, which may start none', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.scan('pty-1', 'term', 'claude')
    await post(env, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sent = agents.send('term', '/compact')
      await vi.waitFor(() => expect(terminal.writes).toHaveLength(2))
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(sent).resolves.toEqual({ ok: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flags an agent running without Cate hooks until one of its hooks arrives', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.scan('pty-1', 'term', 'claude')
    await vi.waitFor(() => expect(agents.panels.state('term')).toMatchObject({ agentId: 'claude-code', hooksMissing: true }), { timeout: 5_000 })

    await post(env, 'claude-code', { hook_event_name: 'SessionStart', session_id: 'sess-1', cwd: root })
    expect(agents.panels.state('term')).not.toHaveProperty('hooksMissing')
  })

  it('does not flag an agent whose hook files are installed where it runs', async () => {
    hookConfig = { 'claude-code': 'on' }
    await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    expect(await agents.hooks.hooksInstalled(root, 'claude-code')).toBe(true)
    terminal.scan('pty-1', 'term', 'claude')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(agents.panels.state('term')).toMatchObject({ agentId: 'claude-code', present: true })
    expect(agents.panels.state('term')).not.toHaveProperty('hooksMissing')
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
    await expect(agentTerminals.conversation('term')).resolves.toEqual({
      session: { agentId: 'claude-code', sessionId: 'sess-1', cwd: root },
      messages: [{ role: 'user', text: 'hi' }],
    })
  })

  it('forgets the terminal when its PTY exits and reports the exit per panel', async () => {
    const exits: Array<[string, number]> = []
    agentTerminals.onExit((panelId, code) => exits.push([panelId, code]))
    const changes = vi.fn()
    agents.panels.subscribe(changes)
    await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    terminal.scan('pty-1', 'term', 'claude')
    expect(agents.panels.state('term')).not.toBeNull()
    terminal.exit('pty-1', 0)
    expect(exits).toEqual([['term', 0]])
    expect(agentTerminals.terminalOf('term')).toBeNull()
    expect(agents.panels.state('term')).toBeNull()
    expect(changes).toHaveBeenLastCalledWith({ term: null })
  })
})

/** Each CLI's completed tool calls as its hooks post them: a file edit and a
 *  shell command, in the spelling the real CLI uses (the tools of the live
 *  lifecycle fixture, `live/hookLifecycle.itest.ts`). */
const TOOL_POSTS: Record<AgentId, { edit: (file: string) => Record<string, unknown>; shell: (command: string) => Record<string, unknown> }> = {
  'claude-code': {
    edit: (file) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'e', tool_name: 'Write', tool_input: { file_path: file, content: 'after\n' }, tool_response: { type: 'create' } }),
    shell: (command) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'b', tool_name: 'Bash', tool_input: { command, description: 'Run it' }, tool_response: { stdout: '', stderr: '' } }),
  },
  codex: {
    edit: (file) => ({ hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', tool_use_id: 'e', tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Add File: ${file}\n+after\n*** End Patch` }, tool_response: 'Success.' }),
    shell: (command) => ({ hook_event_name: 'PostToolUse', session_id: 's', turn_id: 't', tool_use_id: 'b', tool_name: 'Bash', tool_input: { command }, tool_response: '' }),
  },
  cursor: {
    edit: (file) => ({ hook_event_name: 'afterFileEdit', conversation_id: 's', file_path: file, edits: [{ old_string: '', new_string: 'after\n' }] }),
    shell: (command) => ({ hook_event_name: 'postToolUse', conversation_id: 's', tool_use_id: 'b', tool_name: 'Shell', tool_input: { command }, tool_output: '{"exitCode":0}' }),
  },
  grok: {
    edit: (file) => ({ hookEventName: 'post_tool_use', sessionId: 's', toolUseId: 'e', toolName: 'write', toolInput: { file_path: file, content: 'after\n' }, toolResponse: {} }),
    shell: (command) => ({ hookEventName: 'post_tool_use', sessionId: 's', toolUseId: 'b', toolName: 'run_terminal_command', toolInput: { command, description: 'Run it' }, toolResponse: {} }),
  },
  hermes: {
    edit: (file) => ({ hook_event_name: 'post_tool_call', session_id: 's', tool_call_id: 'e', tool_name: 'write_file', args: { path: file, content: 'after\n' }, result: '{}', status: 'completed', platform: 'cli' }),
    shell: (command) => ({ hook_event_name: 'post_tool_call', session_id: 's', tool_call_id: 'b', tool_name: 'terminal', args: { command, workdir: '.' }, result: '{}', status: 'completed', platform: 'cli' }),
  },
  kiro: {
    edit: (file) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'e', tool_name: 'fs_write', tool_input: { path: file, text: 'after\n' }, tool_response: {} }),
    shell: (command) => ({ hook_event_name: 'PostToolUse', session_id: 's', tool_use_id: 'b', tool_name: 'execute_bash', tool_input: { command }, tool_response: {} }),
  },
  opencode: {
    edit: (file) => ({ type: 'message.part.updated', sessionID: 's', part: { type: 'tool', tool: 'write', callID: 'e', state: { status: 'completed', input: { filePath: file, content: 'after\n' }, metadata: {} } } }),
    shell: (command) => ({ type: 'message.part.updated', sessionID: 's', part: { type: 'tool', tool: 'bash', callID: 'b', state: { status: 'completed', input: { command, description: 'Run it' }, metadata: {} } } }),
  },
}

describe('terminal agents steps', () => {
  it.each(Object.keys(TOOL_POSTS) as AgentId[])('%s: a completed edit and command are steps of the panel, named the same way', async (agentId) => {
    const steps: Array<[string, AgentStep]> = []
    agentTerminals.onStep((panelId, step) => steps.push([panelId, step]))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    // CLIs report paths in the canonical checkout (macOS's /var is /private/var).
    await post(env, agentId, TOOL_POSTS[agentId].edit(path.join(fs.realpathSync.native(root), 'src', 'created.txt')))
    await post(env, agentId, TOOL_POSTS[agentId].shell('npm test -- --run\nsecond line'))
    expect(steps.map(([panelId, step]) => [panelId, step.subject])).toEqual([
      ['term', 'src/created.txt'],
      ['term', 'npm test -- --run'],
    ])
    expect(steps.every(([, step]) => step.tool && !Number.isNaN(Date.parse(step.at)))).toBe(true)
  })

  it('a call the CLI says failed is still a step, but never a recorded edit', async () => {
    const steps: AgentStep[] = []
    agentTerminals.onStep((_panelId, step) => steps.push(step))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    const file = path.join(fs.realpathSync(root), 'failed.txt')
    // Each CLI's own failure spelling, where it has one.
    await post(env, 'claude-code', { ...TOOL_POSTS['claude-code'].edit(file), hook_event_name: 'PostToolUseFailure', error: 'denied by the file system' })
    await post(env, 'hermes', { ...TOOL_POSTS.hermes.edit(file), status: 'failed' })
    await post(env, 'kiro', { ...TOOL_POSTS.kiro.edit(file), tool_response: { is_error: true } })
    expect(steps.map((step) => step.subject)).toEqual(['failed.txt', 'failed.txt', 'failed.txt'])
    await expect(agents.changes(root)).resolves.toMatchObject({ records: [] })
  })

  it('a command the person refused is no step, one that failed is', async () => {
    const steps: AgentStep[] = []
    agentTerminals.onStep((_panelId, step) => steps.push(step))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    // Hermes 0.21 reports both through post_tool_call (captured live).
    const hermes = (command: string, result: Record<string, unknown>) => ({
      ...TOOL_POSTS.hermes.shell(command), status: 'error', error_type: 'tool_error', result: JSON.stringify(result),
    })
    await post(env, 'hermes', hermes('rm -rf -- target.txt', { output: '', exit_code: -1, error: 'BLOCKED: User denied this command.', status: 'blocked' }))
    await post(env, 'hermes', hermes('exit 7', { output: '', exit_code: 7, error: null }))
    expect(steps.map((step) => step.subject)).toEqual(['exit 7'])
  })

  it('a post for another terminal, or without a valid token, is no step', async () => {
    const steps: AgentStep[] = []
    agentTerminals.onStep((_panelId, step) => steps.push(step))
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await post({ ...env, CATE_HOOK_TOKEN: 'forged' }, 'claude-code', TOOL_POSTS['claude-code'].shell('ls'))
    await post({ ...env, CATE_TERMINAL_ID: 'pty-unknown' }, 'claude-code', TOOL_POSTS['claude-code'].shell('ls'))
    expect(steps).toEqual([])
  })

  it('a panel\'s conversation carries its steps as they come', async () => {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    await post(env, 'claude-code', { hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: root })
    const seen: AgentStep[][] = []
    const stop = agents.conversations.watch('term', (conversation) => { seen.push(conversation.steps) })
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    await post(env, 'claude-code', TOOL_POSTS['claude-code'].shell('npm test'))
    await vi.waitFor(() => expect(seen.at(-1)?.map((step) => step.subject)).toEqual(['npm test']))
    stop()
  })
})

describe('terminal agentTerminals over the terminal service', () => {
  // As node-pty: a killed PTY reports its exit later, not inside kill().
  const latePty = (): PtySpawner => () => {
    const exits: Array<(e: { exitCode: number }) => void> = []
    const pty: PtyProcess = {
      pid: 4242,
      onData: () => {},
      onExit: (listener) => { exits.push(listener) },
      write: () => {},
      resize: () => {},
      kill: () => { setTimeout(() => { for (const listener of exits) listener({ exitCode: 0 }) }, 0) },
      pause: () => {},
      resume: () => {},
    }
    return pty
  }
  const service = (spawnPty: PtySpawner) => createTerminalService({
    root,
    logDir: path.join(root, 'logs'),
    trust: { isTrusted: () => true, requireTrusted: () => {} },
    settings: { getAll: () => ({ defaultShellPath: '', terminalScrollback: 100, autoSuspendIdleTerminals: false }), subscribe: () => () => {} },
    log: createLogger('test'),
    env: () => ({ PATH: '/usr/bin' }),
    spawnPty,
    resolveShell: () => ({ path: '/bin/sh', args: [] }),
    signalGroup: () => {},
  })

  it('forgets a terminal that was closed', async () => {
    const terminals = service(latePty())
    agentTerminals.dispose()
    agentTerminals = createTerminalAgents(agents, terminals, { stampsFile })
    const { id } = await terminals.spawn({ cols: 80, rows: 24, panelId: 'term' })
    expect(agentTerminals.terminalOf('term')).toBe(id)
    terminals.close(id)
    await new Promise((r) => setTimeout(r, 10))
    expect(agentTerminals.terminalOf('term')).toBeNull()
    await terminals.shutdown()
  })

  it('forgets a terminal whose spawn failed', async () => {
    const terminals = service(() => { throw new Error('posix_spawnp failed') })
    agentTerminals.dispose()
    agentTerminals = createTerminalAgents(agents, terminals, { stampsFile })
    await expect(terminals.spawn({ cols: 80, rows: 24, panelId: 'term' })).rejects.toThrow()
    expect(agentTerminals.terminalOf('term')).toBeNull()
    await expect(agentTerminals.send('term', 'hello')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
    await terminals.shutdown()
  })
})

// PTY input and agent hooks share one ordered status stream.
describe('terminal agentTerminals input and hook ordering', () => {
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
  const status = () => agents.panels.state('term')?.status

  // The agent process a hook post names: presence registers it from the post.
  const AGENT_PID = 4242
  async function setup() {
    const env = await terminal.spawn({ terminalId: 'pty-1', panelId: 'term', cwd: root })
    return async (agentId: AgentId, payload: Record<string, unknown>) => {
      procTree.nameByPid.set(AGENT_PID, AGENT_DEFS[agentId].command)
      const output = await post(env, agentId, { ...ids, ...payload }, AGENT_PID)
      terminal.scan('pty-1', 'term', 'node')
      return output
    }
  }

  it('covers every CLI agent', async () => {
    const { AGENTS } = await import('../contract')
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
    expect(agents.panels.state('term')).toBeNull()
  })

  it('recovers a Kiro Ctrl-C interrupt from PTY input', async () => {
    const send = await setup()
    await send('kiro', { hook_event_name: 'UserPromptSubmit' })
    expect(status()).toBe('running')
    terminal.service.write('pty-1', '\x03')
    expect(status()).toBe('waitingForInput')
    expect(notifications).toEqual([]) // a recovered interrupt is silent
  })
  it('interrupts with the CLI\'s own keys, which end a Kiro turn the same way', async () => {
    const send = await setup()
    await expect(agentTerminals.interrupt('term')).resolves.toEqual({ ok: false, error: 'agent-not-running' })
    await send('kiro', { hook_event_name: 'UserPromptSubmit' })
    await expect(agentTerminals.interrupt('term')).resolves.toEqual({ ok: true })
    expect(terminal.writes.at(-1)).toEqual({ id: 'pty-1', data: '\x03' })
    expect(status()).toBe('waitingForInput')
  })

  it('presses opencode\'s Esc twice, the second confirming the first', async () => {
    const send = await setup()
    await send('opencode', { type: 'session.status', status: { type: 'busy' } })
    const before = terminal.writes.length
    await expect(agentTerminals.interrupt('term')).resolves.toEqual({ ok: true })
    expect(terminal.writes.slice(before)).toEqual([{ id: 'pty-1', data: '\x1b' }, { id: 'pty-1', data: '\x1b' }])
  })
})
