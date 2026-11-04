import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { AGENT_SETUP_ADAPTERS, setupAuthentication } from './adapters'
import { createAgentSetup } from './service'
import { createSetupFixture } from './setupFixture'
import { AGENTS, AGENT_DEFS, type AgentId, type AgentAvailability } from '../../contract'

const directories: string[] = []
const disposals: Array<() => void> = []
afterEach(async () => { disposals.splice(0).forEach((dispose) => dispose()); await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })
async function fixture() {
  const f = await createSetupFixture()
  directories.push(f.root)
  disposals.push(() => { f.setup.dispose(); f.deps.secrets.dispose() })
  return f
}

describe('agent setup', () => {
  it('publishes settings changes to all clients without CLI probes or network requests', async () => {
    const { setup, deps, fetcher, probe } = await fixture()
    await setup.inspect()
    const first: AgentAvailability[] = [], second: AgentAvailability[] = []
    const offFirst = setup.watch((state) => first.push(state))
    const offSecond = setup.watch((state) => second.push(state))
    probe.mockClear(); fetcher.mockClear()
    await deps.preferences.set({ codex: { connection: 'api', providerId: 'missing', model: 'model-one' } })
    setup.preferencesChanged()
    for (const updates of [first, second]) {
      expect(updates.at(-1)?.snapshot?.agents.find((agent) => agent.agentId === 'codex')).toMatchObject({ connection: 'api', providerId: 'missing', model: 'model-one' })
      expect(updates.at(-1)?.types.find((agent) => agent.agentId === 'codex')).toMatchObject({ connection: 'api', model: 'model-one' })
    }
    expect(probe).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    offFirst(); offSecond()
  })
  it('requires Pi 1.4 and preserves an explicit upgrade instruction', async () => {
    const { setup, probe } = await fixture()
    probe.mockResolvedValue({ code: 0, stdout: '0.76.0' })
    const info = (await setup.inspect()).agents.find((agent) => agent.agentId === 'pi')!
    expect(info.installation).toMatchObject({ status: 'error', detail: expect.stringContaining('1.4.0') })
    await expect(setup.ensureReady('pi')).rejects.toThrow('agent-cli-not-installed')
    expect(info.canInstall).toBe(true)
  })
  it('allows Cursor API authentication when native status reports no subscription login', async () => {
    const { setup, deps, probe } = await fixture()
    probe.mockImplementation(async (_command, args) => ({ code: 0, stdout: args[0] === '--version' ? '1.0.0' : '{"isAuthenticated":false}' }))
    deps.env = () => ({ CURSOR_API_KEY: 'private-runtime-key' })
    await expect(setup.ensureReady('cursor')).resolves.toBeUndefined()
    const info = (await setup.inspect()).agents.find((agent) => agent.agentId === 'cursor')!
    expect(info.authentication).toMatchObject({ status: 'signed-in', method: 'api_key' })
    expect(JSON.stringify(info)).not.toContain('private-runtime-key')
    deps.env = () => ({})
    await setup.inspect(true)
    await expect(setup.ensureReady('cursor')).rejects.toThrow('signed-out')
  })
  const loginCommands: Record<AgentId, string[]> = {
    'claude-code': ['auth', 'login'], codex: ['login', '--device-auth'], cursor: ['login'],
    pi: [],
    grok: ['login', '--device-auth'], kiro: ['login', '--use-device-flow'], opencode: ['auth', 'login'],
  }
  it('rejects untrusted setup and provider work before probing, fetching or opening terminals', async () => {
    const { setup, deps, probe, fetcher } = await fixture()
    deps.trust.requireTrusted = () => { throw new Error('untrusted') }
    for (const call of [
      () => setup.inspect(), () => setup.ensureReady('codex'),
      () => setup.begin({ agentId: 'codex', action: 'login' }),
      () => setup.configure({ agentId: 'codex', connection: 'native' }),
      async () => { setup.providers.remove({ id: 'missing' }) },
      async () => { await setup.providers.models({ id: 'missing' }) },
      async () => { setup.providers.save({ name: 'test', baseUrl: 'https://test.example/v1', api: 'responses', models: [{ id: 'test' }], apiKey: 'key' }) },
      () => setup.prepareLaunch('codex', { executable: 'codex', args: [] }),
    ]) await expect(call()).rejects.toThrow('untrusted')
    expect(() => setup.operation('op')).toThrow('untrusted')
    expect(() => setup.cancel('op')).toThrow('untrusted')
    expect(probe).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
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
    await expect(setup.ensureReady(id)).rejects.toThrow('not-installed')
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
  it('declares native login/install/download for every harness and no proprietary gateway claim', () => {
    expect(Object.keys(AGENT_SETUP_ADAPTERS)).toHaveLength(7)
    for (const adapter of Object.values(AGENT_SETUP_ADAPTERS)) { expect(adapter.downloadUrl).toMatch(/^https:/); expect(adapter.login.length > 0 || adapter.loginHint).toBeTruthy(); expect(adapter.installer.unix).toBeDefined() }
    expect(AGENT_SETUP_ADAPTERS.cursor.apiProtocol).toBeNull(); expect(AGENT_SETUP_ADAPTERS.kiro.apiProtocol).toBeNull()
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
    const info = await setup.configure({ agentId: 'codex', connection: 'native' })
    expect(deps.enable).toHaveBeenCalledWith('codex')
    expect(info.hooksReady).toBe(true)
    await expect(setup.ensureReady('codex')).rejects.toThrow('signed-out')
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

describe('custom API providers', () => {
  const save = async (f: Awaited<ReturnType<typeof fixture>>, agentId: AgentId, extra = {}) => f.setup.providers.save({
    name: 'My provider', baseUrl: 'https://provider.example/custom/v1', api: AGENT_SETUP_ADAPTERS[agentId].apiProtocol!,
    models: [{ id: 'vendor/model', maxInputTokens: 64000, maxOutputTokens: 4096 }], apiKey: 'private-key', ...extra,
  })

  it.each(['claude-code', 'codex', 'opencode', 'grok', 'pi'] as const)('%s routes launch and resume directly, preserves native configuration and uses current settings', async (agentId) => {
    const f = await fixture()
    const provider = await save(f, agentId)
    const command = { executable: AGENT_DEFS[agentId].command, args: ['--resume', 'session'] }
    expect(await f.setup.prepareLaunch(agentId, command)).toEqual({ command })
    await f.setup.configure({ agentId, connection: 'api', providerId: provider.id, model: 'vendor/model' })
    await expect(f.setup.ensureReady(agentId)).resolves.toBeUndefined()
    const plan = await f.setup.prepareLaunch(agentId, command)
    expect(plan.env?.CATE_PROVIDER_API_KEY).toBe('private-key')
    expect(plan.command?.args.slice(-2)).toEqual(command.args)
    expect(JSON.stringify(plan.command)).not.toContain('private-key')
    expect(JSON.stringify(await f.setup.inspect())).not.toContain('private-key')
    expect(JSON.stringify(f.deps.providers.get())).not.toContain('private-key')
    if (agentId === 'codex') expect(plan.command?.args).toContain('model_providers.cate.base_url="https://provider.example/custom/v1"')
    if (agentId === 'opencode') expect(JSON.parse(plan.env!.OPENCODE_CONFIG_CONTENT).provider.cate).toMatchObject({ options: { baseURL: provider.baseUrl }, models: { 'vendor/model': { limit: { context: 64000, output: 4096 } } } })
    if (agentId === 'pi' || agentId === 'grok') {
      const file = agentId === 'pi' ? plan.command!.args[plan.command!.args.indexOf('--extension') + 1] : path.join(plan.env!.GROK_HOME, 'config.toml')
      const config = await readFile(file, 'utf8')
      expect(config).not.toContain('private-key')
      expect(config).toContain(provider.baseUrl)
      expect(config).toContain('CATE_PROVIDER_API_KEY')
      if (agentId === 'pi') { expect(config).toContain('"contextWindow":64000'); expect(config).toContain('"maxTokens":4096') }
    }
    const { hasKey: _hasKey, ...metadata } = provider
    await f.setup.providers.save({ ...metadata, apiKey: 'replacement-key', models: [{ id: 'vendor/model', maxInputTokens: 32000 }] })
    f.setup.dispose()
    const restored = createAgentSetup(f.deps); disposals.push(() => restored.dispose())
    expect((await restored.prepareLaunch(agentId, command)).env?.CATE_PROVIDER_API_KEY).toBe('replacement-key')
    await restored.providers.remove({ id: provider.id })
    await expect(restored.prepareLaunch(agentId, command)).rejects.toThrow('configured API provider')
    await expect(restored.ensureReady(agentId)).rejects.toThrow('configured API provider')
    expect((await restored.types()).find((a) => a.agentId === agentId)?.ready).toBe(false)
    await restored.configure({ agentId, connection: 'native' })
    expect(await restored.prepareLaunch(agentId, command)).toEqual({ command })
  })

  it('retains saved keys on edits, serializes concurrent writes and removes keys durably', async () => {
    const f = await fixture()
    const [a, b] = await Promise.all([save(f, 'codex'), save(f, 'pi')])
    expect(f.setup.providers.list()).toHaveLength(2)
    const { id, hasKey: _hasKey, ...metadata } = a
    await f.setup.providers.save({ ...metadata, id, name: 'Renamed' })
    expect(f.setup.providers.get(id).credential).toBe('private-key')
    const file = path.join(f.root, 'secrets.json')
    expect(JSON.parse(await readFile(file, 'utf8')).agentProviderKeys[id]).toBe('private-key')
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    await f.setup.providers.remove({ id })
    expect(JSON.parse(await readFile(file, 'utf8')).agentProviderKeys).toEqual({ [b.id]: 'private-key' })
  })

  it('rejects incompatible protocols and missing models before selecting a provider', async () => {
    const f = await fixture()
    const p = await save(f, 'pi')
    await expect(f.setup.configure({ agentId: 'codex', connection: 'api', providerId: p.id, model: 'vendor/model' })).rejects.toThrow('compatible')
    await expect(f.setup.configure({ agentId: 'pi', connection: 'api', providerId: p.id, model: 'unknown' })).rejects.toThrow('model')
    for (const agentId of ['cursor', 'kiro'] as const) await expect(f.setup.configure({ agentId, connection: 'api', providerId: p.id, model: 'vendor/model' })).rejects.toThrow(AGENT_SETUP_ADAPTERS[agentId].apiReason)
    expect(f.deps.preferences.get()).toEqual({})
  })

  it('rejects unsafe URLs, invalid limits and missing keys while allowing path prefixes and local HTTP', async () => {
    const f = await fixture()
    for (const baseUrl of ['http://provider.example', 'https://user:secret@provider.example', 'https://provider.example/?key=secret', 'https://provider.example/#secret']) await expect(save(f, 'codex', { baseUrl })).rejects.toThrow('base URL')
    await expect(save(f, 'pi', { models: [{ id: 'x', maxInputTokens: -1 }] })).rejects.toThrow('model')
    await expect(save(f, 'pi', { apiKey: undefined })).rejects.toThrow('API key')
    await expect(save(f, 'pi', { baseUrl: 'http://127.0.0.1:1234/prefix/v1' })).resolves.toMatchObject({ hasKey: true })
  })

  it('discovers Anthropic models using the SDK base and API-key header', async () => {
    const f = await fixture()
    const p = await save(f, 'claude-code', { baseUrl: 'https://provider.example/anthropic' })
    await f.setup.providers.models({ id: p.id })
    expect(f.fetcher).toHaveBeenCalledWith('https://provider.example/anthropic/v1/models', expect.objectContaining({ headers: { 'x-api-key': 'private-key', 'anthropic-version': '2023-06-01' } }))
  })

  it('loads models only on explicit request and leaves manual configuration usable on failure', async () => {
    const f = await fixture()
    const p = await save(f, 'codex')
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(await f.setup.providers.models({ id: p.id })).toEqual([{ id: 'model-one' }])
    expect(f.fetcher).toHaveBeenCalledWith('https://provider.example/custom/v1/models', expect.objectContaining({ headers: { authorization: 'Bearer private-key' }, redirect: 'error' }))
    f.fetcher.mockResolvedValueOnce(new Response('', { status: 404 }))
    await expect(f.setup.providers.models({ id: p.id })).rejects.toThrow('manually')
    await f.setup.configure({ agentId: 'codex', connection: 'api', providerId: p.id, model: 'vendor/model' })
    await expect(f.setup.prepareLaunch('codex', { executable: 'codex', args: [] })).resolves.toBeDefined()
  })
})
