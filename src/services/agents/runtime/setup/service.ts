import type { AgentAvailability, AgentTypeInfo } from '../../contract'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createJsonStateFile, writeFileAtomic } from '@kernel/state/node'
import { mkdir } from 'node:fs/promises'
import { RpcError } from '@kernel/rpc/contract'
import { AGENTS, AGENT_DEFS, isAgentId, type AgentId, type AgentSetupConfigureRequest, type AgentSetupInfo, type AgentSetupOperation, type AgentSetupSnapshot } from '../../contract'
import type { LaunchPlan, LaunchCommand } from '@services/terminal/runtime'
import type { AgentStartPorts } from '../start'
import type { AgentTerminalService } from '../terminal'
import type { TrustGate } from '../core'
import { AGENT_SETUP_ADAPTERS, setupAuthentication } from './adapters'
import { providerLaunch } from './launch'
import { probeJsonLines } from '../usage/probe'

import type { AgentPreferences } from '../../contract/settings'
import { createProviders, type ProviderStore } from './providers'
import type { JsonStateFile } from '@kernel/state/node'
import type { SecretsFile } from '@runtime/data/runtime'

export const AGENT_SETUP_LAUNCH = 'agents.setup'
interface SetupState {
  operations: Record<string, AgentSetupOperation>
}
const empty: SetupState = { operations: {} }
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
function normalize(value: unknown): SetupState {
  const v = record(value)
  const operations: SetupState['operations'] = {}
  for (const [id, raw] of Object.entries(record(v.operations))) {
    const op = record(raw)
    if (op.id === id && isAgentId(op.agentId) && (op.action === 'login' || op.action === 'install') && typeof op.startedAt === 'string' && ['running', 'completed', 'failed', 'cancelled'].includes(String(op.status))) operations[id] = op as unknown as AgentSetupOperation
  }
  return { operations }
}
export interface SetupProbeResult { stdout: string; stderr?: string; code: number; missing?: boolean }
export interface AgentSetupDeps {
  root: string
  agentsDir: string
  secrets: JsonStateFile<SecretsFile>
  homeDir?: string
  env(): NodeJS.ProcessEnv
  trust: TrustGate
  start: AgentStartPorts
  terminal: AgentTerminalService
  providers: ProviderStore
  preferences: { get(): AgentPreferences; set(value: AgentPreferences): Promise<void> }
  enable?(agentId: AgentId): Promise<void>
  hooksReady?(agentId: AgentId): Promise<boolean>
  /** Tests: avoid invoking real installers, auth or paid endpoints. */
  probe?: (executable: string, args: readonly string[]) => Promise<SetupProbeResult>
  fetch?: typeof globalThis.fetch
  platform?: NodeJS.Platform
}
export interface AgentSetupService {
  types(): Promise<AgentTypeInfo[]>
  invalidate(): void
  preferencesChanged(): void
  watch(listener: (state: AgentAvailability) => void): () => void
  inspect(refresh?: boolean): Promise<AgentSetupSnapshot>
  ensureReady(agentId: AgentId): Promise<void>
  begin(input: { agentId: AgentId; action: 'login' | 'install' }): Promise<AgentSetupOperation>
  operation(id: string): AgentSetupOperation | null
  cancel(id: string): { ok: true }
  configure(input: AgentSetupConfigureRequest): Promise<AgentSetupInfo>
  providers: ReturnType<typeof createProviders>
  prepareLaunch(agentId: AgentId, command: LaunchCommand): Promise<LaunchPlan>
  dispose(): void
}
export function createAgentSetup(deps: AgentSetupDeps): AgentSetupService {
  const state = createJsonStateFile<SetupState>({ file: path.join(deps.agentsDir, 'setup.json'), defaults: empty, normalize, mode: 0o600 })
  state.load()
  // A daemon restart cannot claim to still own a previous installation/login.
  state.update((s) => ({ ...s, operations: Object.fromEntries(Object.entries(s.operations).map(([id, op]) => [id, op.status === 'running' ? { ...op, status: 'failed', message: 'Runtime restarted. Refresh account status before trying again.' } : op])) }))
  const platform = deps.platform ?? process.platform
  const providers = createProviders({ store: deps.providers, secrets: deps.secrets, trust: deps.trust, fetch: deps.fetch, changed: () => { service.preferencesChanged(); service.invalidate() } })
  const terminalIds = new Map<string, string>()
  const cache = new Map<AgentId, { at: number; info: AgentSetupInfo }>()
  const probe = deps.probe ?? ((executable, args) => new Promise<SetupProbeResult>((resolve) => {
    const windows = platform === 'win32'
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`
    const binary = windows ? 'powershell.exe' : executable
    const argv = windows ? ['-NoProfile', '-NonInteractive', '-Command', `& ${[executable, ...args].map(quote).join(' ')}`] : [...args]
    execFile(binary, argv, { cwd: deps.root, env: deps.env(), timeout: 8000, maxBuffer: 256 * 1024, windowsHide: true }, (error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? typeof error.code === 'number' ? error.code : 1 : 0, missing: (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' }))
  }))
  const requireAgent = (agentId: AgentId) => { if (!isAgentId(agentId)) throw new RpcError('rejected', 'Unsupported agent.') }
  const selection = (agentId: AgentId) => {
    const preference = deps.preferences.get()[agentId]
    if (preference?.connection !== 'api') return null
    const adapter = AGENT_SETUP_ADAPTERS[agentId]
    if (!adapter.apiProtocol) throw new RpcError('rejected', adapter.apiReason!)
    const { provider, credential } = providers.get(preference.providerId ?? '')
    if (provider.api !== adapter.apiProtocol) throw new RpcError('rejected', 'The provider API protocol is not compatible with this agent.')
    const model = provider.models.find((m) => m.id === preference.model)
    if (!model) throw new RpcError('rejected', 'Select a model for this agent in Agents settings.')
    return { provider, credential, model }
  }
  const connectionInfo = (agentId: AgentId) => {
    const preference = deps.preferences.get()[agentId]
    const adapter = AGENT_SETUP_ADAPTERS[agentId]
    let configured = false
    try { configured = selection(agentId) !== null } catch { /* Invalid selections remain visible and block launch. */ }
    return { connection: preference?.connection ?? 'native' as const, providerId: preference?.providerId, model: preference?.model,
      api: { protocol: adapter.apiProtocol, reason: adapter.apiReason, configured } }
  }
  const infoFor = async (agentId: AgentId, refresh = false): Promise<AgentSetupInfo> => {
    const previous = cache.get(agentId)
    if (!refresh && previous && Date.now() - previous.at < 15_000) {
      return { ...previous.info, ...connectionInfo(agentId), hooksReady: await deps.hooksReady?.(agentId) ?? false }
    }
    const adapter = AGENT_SETUP_ADAPTERS[agentId]
    const command = AGENT_DEFS[agentId].command
    const version = await probe(command, ['--version'])
    const versionText = (version.stdout.trim() || version.stderr || '').trim().split('\n')[0].slice(0, 160)
    const minimum = adapter.minimumVersion?.split('.').map(Number)
    const found = versionText.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:$|\s)/)?.slice(1).map(Number)
    const tooOld = !!minimum && (!found || found[0] < minimum[0] || found[0] === minimum[0] && (found[1] < minimum[1] || found[1] === minimum[1] && found[2] < minimum[2]))
    const installed = !version.missing && version.code === 0 && !tooOld
    const windowsUnsupported = platform === 'win32' && agentId === 'cursor'
    let authentication: AgentSetupInfo['authentication'] = { status: 'unknown', detail: installed ? 'Account inspection is not available for this CLI.' : 'Install the CLI to inspect its account.' }
    if (installed && adapter.status) {
      const response = await probe(command, adapter.status)
      authentication = setupAuthentication(agentId, response.stdout.trim() || response.stderr || '', response.code)
      // Cursor's status describes its subscription login even when the CLI
      // accepts an API key from the environment for inference. As with Codex's
      // saved-key status, configured does not mean the provider verified it.
      if (agentId === 'cursor' && deps.env().CURSOR_API_KEY?.trim()) {
        authentication = { status: 'signed-in', method: 'api_key', detail: 'API key configured in the runtime environment.' }
      }
      if (agentId === 'codex' && !deps.probe) {
        try {
          const account = await probeJsonLines<Record<string, unknown>>({ command, args: ['app-server'], cwd: deps.root, env: deps.env(),
            converse(send, line) { if (!line) send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'cate_setup', version: '1.0.0' } } }); else if (line.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/read', params: {} }) } },
            answer(line) { return line.id === 2 ? record(record(line.result).account) : undefined },
          })
          authentication = { ...authentication, ...setupAuthentication(agentId, JSON.stringify({ account }), response.code), status: authentication.status }
        } catch { /* Status remains valid when the richer account probe is unavailable. */ }
      }
    }
    // Grok has no machine-readable whoami; do not infer authentication from config or token presence.
    const info: AgentSetupInfo = {
      agentId, displayName: AGENT_DEFS[agentId].displayName, downloadUrl: adapter.downloadUrl,
      installation: { status: installed ? 'installed' : windowsUnsupported ? 'unsupported' : version.missing ? 'missing' : 'error', ...(installed ? { version: versionText, executable: command } : version.missing ? {} : { detail: tooOld ? `Update this CLI to ${adapter.minimumVersion} or newer for Cate support.` : 'The CLI version check failed.' }) },
      authentication, ...connectionInfo(agentId),
      hooksReady: await deps.hooksReady?.(agentId) ?? false,
      canLogin: installed, canInstall: !windowsUnsupported && !!(platform === 'win32' ? adapter.installer.windows : adapter.installer.unix),
    }
    cache.set(agentId, { at: Date.now(), info })
    return info
  }
  const finish = (id: string, status: AgentSetupOperation['status'], message?: string) => {
    state.update((s) => { const op = s.operations[id]; return !op || op.status !== 'running' ? s : { ...s, operations: { ...s.operations, [id]: { ...op, status, ...(message ? { message } : {}) } } } })
    cache.clear()
    service.invalidate()
  }
  const offEnv = deps.terminal.registerEnvContributor((spawn) => {
    if (spawn.launch?.kind === AGENT_SETUP_LAUNCH) {
      const id = record(spawn.launch.params).operationId
      if (typeof id === 'string') terminalIds.set(id, spawn.terminalId)
    }
  })
  const offExit = deps.terminal.onExit((terminalId, exitCode) => {
    for (const [id, terminal] of terminalIds) if (terminal === terminalId) { terminalIds.delete(id); finish(id, exitCode === 0 ? 'completed' : 'failed', exitCode === 0 ? 'Refresh to see the updated agent status.' : 'The setup command exited without completing. Open its terminal for details.') }
  })
  const offLaunch = deps.terminal.registerLaunchIntent(AGENT_SETUP_LAUNCH, async (params) => {
    deps.trust.requireTrusted()
    const id = record(params).operationId
    const op = typeof id === 'string' ? state.get().operations[id] : null
    if (!op || op.status !== 'running') throw new RpcError('rejected', 'Setup operation is no longer active.')
    const adapter = AGENT_SETUP_ADAPTERS[op.agentId]
    const command = op.action === 'login' ? { executable: AGENT_DEFS[op.agentId].command, args: [...adapter.login] } : platform === 'win32' ? adapter.installer.windows : adapter.installer.unix
    if (!command) throw new RpcError('rejected', 'Use the official download for this platform.')
    if (op.action === 'login' && adapter.loginExtension) {
      const directory = path.join(deps.agentsDir, 'setup')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const extension = path.join(directory, `${op.id}.js`)
      await writeFileAtomic(extension, adapter.loginExtension, { mode: 0o600 })
      if (state.get().operations[op.id]?.status !== 'running') throw new RpcError('rejected', 'Setup operation is no longer active.')
      return { command: { ...command, args: [...command.args, '--extension', extension] } }
    }
    return { command }
  })
  let availability: AgentAvailability = { snapshot: null, types: [], refreshing: false, error: null }
  const listeners = new Set<(state: AgentAvailability) => void>()
  let inspection: Promise<AgentSetupSnapshot> | null = null
  let invalidation = 0
  let checkedAt = 0
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  const publish = (next: AgentAvailability) => {
    availability = next
    for (const listener of listeners) listener(next)
  }
  const typesFor = (agents: AgentSetupInfo[]) => agents.map((agent) => {
    const setupReason = agent.installation.status !== 'installed' ? 'Install this CLI in Agents settings.' : agent.connection === 'native' && agent.authentication.status === 'signed-out' ? 'Sign in to this CLI in Agents settings.' : agent.connection === 'api' && !agent.api.configured ? 'Configure an API provider and model in Agents settings.' : !agent.hooksReady ? 'Enable this agent in Agents settings.' : undefined
    return { agentId: agent.agentId, displayName: agent.displayName, ready: !setupReason, connection: agent.connection, ...(agent.model ? { model: agent.model } : {}), ...(setupReason ? { setupReason } : {}) }
  })
  const refreshInBackground = () => { if (!disposed && listeners.size) void service.inspect().catch(() => {}) }
  const service: AgentSetupService = {
    async types() { await service.inspect(); return availability.types },
    preferencesChanged() {
      if (!availability.snapshot) return
      const agents = availability.snapshot.agents.map((agent) => {
        return { ...agent, ...connectionInfo(agent.agentId) }
      })
      publish({ ...availability, snapshot: { ...availability.snapshot, agents, providers: providers.list() }, types: typesFor(agents) })
    },
    invalidate() {
      invalidation++
      cache.clear()
      checkedAt = 0
      refreshInBackground()
    },
    watch(listener) {
      deps.trust.requireTrusted()
      listeners.add(listener)
      listener(availability)
      refreshInBackground()
      timer ??= setInterval(refreshInBackground, 15_000)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) { clearInterval(timer); timer = undefined }
      }
    },
    inspect(refresh) {
      try { deps.trust.requireTrusted() } catch (error) { return Promise.reject(error) }
      if (inspection) return inspection
      if (!refresh && availability.snapshot && Date.now() - checkedAt < 15_000) return Promise.resolve(availability.snapshot)
      const initialVersion = invalidation
      publish({ ...availability, refreshing: true, error: null })
      inspection = (async () => {
        try {
          while (true) {
            const version = invalidation
            const force = refresh || version !== initialVersion
            const snapshot: AgentSetupSnapshot = { host: { name: os.hostname(), platform, arch: os.arch() }, providers: providers.list(), agents: await Promise.all(AGENTS.map((a) => infoFor(a.id, force))), operations: Object.values(state.get().operations).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30) }
            const types = typesFor(snapshot.agents)
            if (version !== invalidation) continue
            checkedAt = Date.now()
            publish({ snapshot, types, refreshing: false, error: null })
            return snapshot
          }
        } catch (error) {
          publish({ ...availability, refreshing: false, error: 'Could not inspect agents on this runtime. Try refreshing.' })
          throw error
        } finally { inspection = null }
      })()
      return inspection
    },
    async ensureReady(agentId) {
      deps.trust.requireTrusted(); requireAgent(agentId)
      const info = (await service.inspect()).agents.find((agent) => agent.agentId === agentId)!
      if (info.installation.status !== 'installed') throw new RpcError('rejected', 'agent-cli-not-installed: Open Agents settings to install this CLI.')
      if (info.connection === 'api') selection(agentId)
      else if (info.authentication.status === 'signed-out') throw new RpcError('rejected', 'agent-cli-signed-out: Open Agents settings to sign in.')
    },
    async begin(input) {
      deps.trust.requireTrusted(); requireAgent(input.agentId)
      if (input.action !== 'install' && input.action !== 'login') throw new RpcError('rejected', 'Unsupported setup action.')
      const ongoing = Object.values(state.get().operations).find((op) => op.agentId === input.agentId && op.status === 'running')
      if (ongoing) return { ...ongoing }
      const info = await infoFor(input.agentId, true)
      if (!(input.action === 'login' ? info.canLogin : info.canInstall)) throw new RpcError('rejected', input.action === 'login' ? 'Install the CLI before signing in.' : 'Use the official download for this platform.')
      await deps.enable?.(input.agentId)
      const op: AgentSetupOperation = { id: randomUUID(), agentId: input.agentId, action: input.action, status: 'running', ...(input.action === 'login' && AGENT_SETUP_ADAPTERS[input.agentId].loginHint ? { message: AGENT_SETUP_ADAPTERS[input.agentId].loginHint } : {}), startedAt: new Date().toISOString() }
      state.update((s) => ({ ...s, operations: { ...s.operations, [op.id]: op } }))
      await state.flushDurable()
      try {
        const panelId = await deps.start.terminals.create({ cwd: deps.root, title: `${input.action === 'login' ? 'Sign in to' : 'Install'} ${info.displayName}`, launch: { kind: AGENT_SETUP_LAUNCH, params: { operationId: op.id } }, placement: {} })
        state.update((s) => ({ ...s, operations: { ...s.operations, [op.id]: { ...s.operations[op.id], panelId } } }))
      } catch { finish(op.id, 'failed', 'The setup terminal could not be started.') }
      return { ...state.get().operations[op.id] }
    },
    operation(id) { deps.trust.requireTrusted(); const op = state.get().operations[id]; return op ? { ...op } : null },
    cancel(id) { deps.trust.requireTrusted(); const terminalId = terminalIds.get(id); finish(id, 'cancelled'); if (terminalId) { if (deps.terminal.kill) deps.terminal.kill(terminalId); else deps.terminal.write(terminalId, '\x03') } return { ok: true } },
    providers,
    async configure(input) {
      deps.trust.requireTrusted(); requireAgent(input.agentId)
      if (input.connection !== 'native' && input.connection !== 'api') throw new RpcError('rejected', 'Unsupported connection.')
      const preference = input.connection === 'native' ? { connection: 'native' as const } : { connection: 'api' as const, providerId: input.providerId, model: input.model }
      if (input.connection === 'api') {
        const adapter = AGENT_SETUP_ADAPTERS[input.agentId]
        if (!adapter.apiProtocol) throw new RpcError('rejected', adapter.apiReason!)
        const { provider } = providers.get(input.providerId ?? '')
        if (provider.api !== adapter.apiProtocol) throw new RpcError('rejected', 'The provider API protocol is not compatible with this agent.')
        if (!provider.models.some((m) => m.id === input.model)) throw new RpcError('rejected', 'Select a configured model for this provider.')
      }
      await deps.enable?.(input.agentId)
      await deps.preferences.set({ ...deps.preferences.get(), [input.agentId]: preference })
      service.preferencesChanged()
      return infoFor(input.agentId)
    },
    async prepareLaunch(agentId, command) {
      deps.trust.requireTrusted(); requireAgent(agentId)
      const selected = selection(agentId)
      if (!selected) return { command }
      const { provider, credential, model } = selected
      return providerLaunch({ agentId, baseUrl: provider.baseUrl, credential, model: model.id, maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens }, command, deps.agentsDir)
    },
    dispose() { disposed = true; clearInterval(timer); listeners.clear(); offEnv(); offExit(); offLaunch(); state.dispose() },
  }
  // Native setup changes publish to every client.
  const refreshAfter = <Args extends unknown[], Result>(work: (...args: Args) => Promise<Result>) => async (...args: Args): Promise<Result> => {
    try { return await work(...args) }
    finally { service.invalidate() }
  }
  service.begin = refreshAfter(service.begin)
  service.configure = refreshAfter(service.configure)
  return service
}
