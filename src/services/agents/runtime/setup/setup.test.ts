import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_SETUP_ADAPTERS, setupAuthentication } from './adapters'
import { createAgentSetup } from './service'
import { createSetupFixture } from './setupFixture'
import { AGENTS, AGENT_DEFS, type AgentId, type AgentAvailability } from '../../contract'

const directories: string[] = []
const disposals: Array<() => void> = []
afterEach(async () => { disposals.splice(0).forEach((dispose) => dispose()); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10 }))) })
async function fixture() {
  const f = await createSetupFixture()
  directories.push(f.root)
  disposals.push(() => { f.setup.dispose() })
  return f
}

describe('agent setup', () => {
  it('requires Pi 1.4 and preserves an explicit upgrade instruction', async () => {
    const { setup, probe } = await fixture()
    probe.mockResolvedValue({ code: 0, stdout: '0.76.0' })
    const info = (await setup.inspect()).agents.find((agent) => agent.agentId === 'pi')!
    expect(info.installation).toMatchObject({ status: 'error', detail: expect.stringContaining('1.4.0') })
    expect(info.canInstall).toBe(true)
  })
  it('allows Cursor API authentication when native status reports no subscription login', async () => {
    const { setup, deps, probe } = await fixture()
    probe.mockImplementation(async (_command, args) => ({ code: 0, stdout: args[0] === '--version' ? '1.0.0' : '{"isAuthenticated":false}' }))
    deps.env = () => ({ CURSOR_API_KEY: 'private-runtime-key' })
    const info = (await setup.inspect()).agents.find((agent) => agent.agentId === 'cursor')!
    expect(info.authentication).toMatchObject({ status: 'signed-in', method: 'api_key' })
    expect(JSON.stringify(info)).not.toContain('private-runtime-key')
    deps.env = () => ({})
    expect((await setup.inspect(true)).agents.find((a) => a.agentId === 'cursor')?.authentication.status).toBe('signed-out')
  })
  const loginCommands: Record<AgentId, string[]> = {
    'claude-code': ['auth', 'login'], codex: ['login', '--device-auth'], cursor: ['login'],
    pi: [],
    grok: ['login', '--device-auth'], kiro: ['login', '--use-device-flow'], opencode: ['auth', 'login'],
  }
  it('rejects untrusted setup work before probing, fetching or opening terminals', async () => {
    const { setup, deps, probe } = await fixture()
    deps.trust.requireTrusted = () => { throw new Error('untrusted') }
    for (const call of [
      () => setup.inspect(),
      () => setup.begin({ agentId: 'codex', action: 'login' }),
    ]) await expect(call()).rejects.toThrow('untrusted')
    expect(() => setup.operation('op')).toThrow('untrusted')
    expect(() => setup.cancel('op')).toThrow('untrusted')
    expect(probe).not.toHaveBeenCalled()
    expect(deps.start.terminals.create).not.toHaveBeenCalled()
  })
  it.each(AGENTS)('$id launches its native login, deduplicates it, and refreshes status after exit', async ({ id }) => {
    const { setup, deps, launch, exits, probe } = await fixture()
    const op = await setup.begin({ agentId: id, action: 'login' })
    expect(await launch.get('agents.setup')!({ operationId: op.id }, { cwd: deps.root, panelId: op.panelId! })).toEqual({ command: { executable: AGENT_DEFS[id].command, args: id === 'pi' ? ['--extension', expect.stringMatching(/setup[/\\].+\.js$/)] : loginCommands[id] } })
    expect((await setup.begin({ agentId: id, action: 'login' })).id).toBe(op.id)
    expect(deps.start.terminals.create).toHaveBeenCalledTimes(1)
    probe.mockImplementation(async (_command, args) => ({ code: 0, stdout: args[0] === '--version' ? '1.4.0' : '{"loggedIn":true,"email":"signed-in@example.test"}' }))
    for (const exit of exits) exit('pty', 0)
    expect(setup.operation(op.id)?.status).toBe('completed')
    const info = (await setup.inspect()).agents.find((a) => a.agentId === id)!
    expect(info.authentication.status).toBe(['grok', 'pi'].includes(id) ? 'unknown' : 'signed-in')
  })
  it.each(AGENTS)('$id handles failed login, retry, cancellation and late exit', async ({ id }) => {
    const { setup, deps, exits, launch } = await fixture()
    deps.terminal.kill = vi.fn()
    const failed = await setup.begin({ agentId: id, action: 'login' })
    for (const exit of exits) exit('pty', 1)
    expect(setup.operation(failed.id)?.status).toBe('failed')
    const retry = await setup.begin({ agentId: id, action: 'login' })
    expect(retry.id).not.toBe(failed.id)
    setup.cancel(retry.id)
    expect(deps.terminal.kill).toHaveBeenCalledWith('pty')
    for (const exit of exits) exit('pty', 0)
    expect(setup.operation(retry.id)?.status).toBe('cancelled')
    await expect(launch.get('agents.setup')!({ operationId: retry.id }, { cwd: deps.root, panelId: null })).rejects.toThrow('no longer active')
  })
  it.each(AGENTS)('$id refuses native login when missing and reports terminal startup failures safely', async ({ id }) => {
    const { setup, deps, probe } = await fixture()
    probe.mockImplementation(async () => ({ code: 127, stdout: '', missing: true }))
    await expect(setup.begin({ agentId: id, action: 'login' })).rejects.toThrow('Install the CLI')
    expect(deps.start.terminals.create).not.toHaveBeenCalled()
    probe.mockImplementation(async () => ({ code: 0, stdout: '1.4.0' }))
    vi.mocked(deps.start.terminals.create).mockRejectedValueOnce(new Error('private setup error'))
    const failed = await setup.begin({ agentId: id, action: 'login' })
    expect(failed.status).toBe('failed')
    expect(JSON.stringify(failed)).not.toContain('private setup error')
    expect((await setup.begin({ agentId: id, action: 'login' })).status).toBe('running')
  })
  it.each(AGENTS)('$id fails an interrupted login on daemon restart and allows retry', async ({ id }) => {
    const { setup, deps } = await fixture()
    const op = await setup.begin({ agentId: id, action: 'login' })
    // begin persists the operation before creating its terminal.
    setup.dispose()
    const restored = createAgentSetup(deps); disposals.push(() => restored.dispose())
    expect(restored.operation(op.id)).toMatchObject({ status: 'failed', message: expect.stringContaining('restarted') })
    expect((await restored.begin({ agentId: id, action: 'login' })).id).not.toBe(op.id)
  })
  it('declares native login/install/download for every harness for every supported CLI', () => {
    expect(Object.keys(AGENT_SETUP_ADAPTERS)).toHaveLength(7)
    for (const adapter of Object.values(AGENT_SETUP_ADAPTERS)) { expect(adapter.downloadUrl).toMatch(/^https:/); expect(adapter.login.length > 0 || adapter.loginHint).toBeTruthy(); expect(adapter.installer.unix).toBeDefined() }
  })
  it('only returns safe public authentication fields, including signed-out Codex', () => {
    expect(setupAuthentication('claude-code', JSON.stringify({ loggedIn: true, email: 'me@example.test', accessToken: 'secret', authMethod: 'oauth' }), 0)).toEqual({ status: 'signed-in', email: 'me@example.test', method: 'oauth' })
    expect(setupAuthentication('codex', 'Not logged in', 0).status).toBe('signed-out')
    expect(setupAuthentication('cursor', '{"isAuthenticated":false,"accessToken":"secret"}', 0)).not.toHaveProperty('accessToken')
  })
  it('explicit setup enables the selected workspace integration and reports fresh hooks readiness', async () => {
    const { setup, deps } = await fixture()
    let enabled = false
    deps.enable = vi.fn(async () => { enabled = true })
    deps.hooksReady = async () => enabled
    expect((await setup.inspect()).agents.find((a) => a.agentId === 'codex')?.hooksReady).toBe(false)
    await setup.begin({ agentId: 'codex', action: 'login' })
    const info = (await setup.inspect()).agents.find((a) => a.agentId === 'codex')!
    expect(deps.enable).toHaveBeenCalledWith('codex')
    expect(info.hooksReady).toBe(true)
    expect(info.authentication.status).toBe('signed-out')
  })
  it('runs native setup in a terminal and persists operation outcomes across restart', async () => {
    const { setup, exits, deps } = await fixture()
    const op = await setup.begin({ agentId: 'codex', action: 'login' })
    expect(op.panelId).toBe('setup-panel'); expect(op.status).toBe('running')
    for (const exit of exits) exit('pty', 0)
    expect(setup.operation(op.id)?.status).toBe('completed')
    setup.dispose(); const restored = createAgentSetup(deps); disposals.push(() => restored.dispose())
    expect(restored.operation(op.id)?.status).toBe('completed')
  })
})


describe('authoritative agent availability', () => {
  it('shares concurrent inspections and publishes refreshed state to every subscriber', async () => {
    const f = await fixture()
    let ready = true
    f.deps.hooksReady = async () => ready
    const first: AgentAvailability[] = []
    const second: AgentAvailability[] = []
    const offFirst = f.setup.watch((state) => first.push(state))
    const offSecond = f.setup.watch((state) => second.push(state))
    try {
      const one = f.setup.inspect()
      expect(f.setup.inspect()).toBe(one)
      const snapshot = await one
      expect(first.at(-1)?.snapshot).toBe(snapshot)
      expect(second.at(-1)?.snapshot).toBe(snapshot)
      expect(await f.setup.types()).toBe(first.at(-1)?.types)
      const probes = f.probe.mock.calls.length
      await f.setup.inspect()
      expect(f.probe.mock.calls.length).toBe(probes)
      ready = false
      await f.setup.inspect(true)
      expect(first.at(-1)).toBe(second.at(-1))
      expect(first.at(-1)?.types.every((type) => !type.ready)).toBe(true)
      const late: AgentAvailability[] = []
      const offLate = f.setup.watch((state) => late.push(state))
      expect(late[0]).toBe(first.at(-1))
      offLate()
    } finally { offFirst(); offSecond() }
  })

  it('publishes setup changes and native operation completion without client polling', async () => {
    const f = await fixture()
    let latest: AgentAvailability | undefined
    const off = f.setup.watch((state) => { latest = state })
    try {
      await f.setup.inspect()
      const op = await f.setup.begin({ agentId: 'codex', action: 'login' })
      await vi.waitFor(() => expect(latest?.snapshot?.operations).toContainEqual(expect.objectContaining({ id: op.id, status: 'running' })))
      for (const exit of f.exits) exit('pty', 0)
      await vi.waitFor(() => expect(latest?.snapshot?.operations).toContainEqual(expect.objectContaining({ id: op.id, status: 'completed' })))
    } finally { off() }
  })
})

it('rechecks invalidated inspections before returning types to another client', async () => {
  const f = await fixture()
  let ready = true
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const probing = new Promise<void>((resolve) => { started = resolve })
  f.deps.hooksReady = async () => {
    const value = ready
    started()
    await gate
    return value
  }
  const seen: AgentAvailability[] = []
  const off = f.setup.watch((state) => seen.push(state))
  try {
    const types = f.setup.types()
    await probing
    ready = false
    f.setup.invalidate()
    release()
    expect((await types).every((type) => !type.ready)).toBe(true)
    expect(seen.filter((state) => state.snapshot).every((state) => state.snapshot!.agents.every((agent) => !agent.hooksReady))).toBe(true)
  } finally { release(); off() }
})
