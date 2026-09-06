import { app, session } from 'electron'
import { createHash, randomBytes, randomUUID } from 'crypto'
import net, { type Server as NetServer, type Socket } from 'net'
import path from 'path'
import log from '../logger'
import { resolveLocator, runtimes } from '../runtime/runtimeManager'
import {
  RUNTIME_INSTALL_ROOT_PLACEHOLDER,
  type Runtime,
} from '../runtime/types'
import { openTunnelDuplex } from '../cateApi/serverTunnel'
import { workspaceCateApi } from '../cateApi/workspaceCateApi'
import { onWindowClosed } from '../windowRegistry'
import {
  harnessKey,
  harnessNodeExecutable,
  harnessPaths,
  partitionFor,
  runtimePath,
} from './harnessIdentity'
import {
  applyCateProviderDefaults,
  applyProviderProfile,
  extractProviderProfile,
  isProviderSecretFile,
} from './providerProfile'
import { cleanProviderAuthOutput, providerAuthCode, providerAuthCommand, providerAuthUrl } from './providerAuth'
import { PROVIDER_STATUS_CACHE, providerStatusFromSnapshot } from './providerStatus'
import { settingsRpc } from './settingsRpc'
import type {
  AgentHarnessPanelRequest,
  AgentHarnessPanelTarget,
  AgentHarnessStatus,
  AgentProviderAuthRequest,
  AgentProviderAuthSession,
  AgentProviderId,
  AgentProviderStatus,
  AgentProviderStatusRequest,
} from '../../shared/t3Agent'

const READY_PATH = '/.well-known/t3/environment'
const START_TIMEOUT_MS = 30_000
const SETTINGS_FLUSH_DELAY_MS = 200

interface HarnessInstance {
  key: string
  runtimeId: string
  cwd: string
  runtime: Runtime
  serverId: string
  remotePort: number
  proxy: NetServer
  proxyPort: number
  baseDir: string
  providerProfilePath: string
  providerSecretsDir: string
  entryPath: string
  bootstrapToken: string
  environmentId: string | null
  panels: Set<string>
}

interface InstanceState {
  runtimeId: string
  phase: AgentHarnessStatus['phase']
  message?: string
  instance?: HarnessInstance
  start?: Promise<HarnessInstance>
}

interface ProviderAuthState extends AgentProviderAuthSession {
  ownerWindowId: number
  runtimeId: string
  runtime: Runtime
  rawOutput: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function listen(server: NetServer): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('T3 proxy did not allocate a TCP port'))
        return
      }
      resolve(address.port)
    })
  })
}

async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    const closable = server as NetServer & { closeAllConnections?: () => void }
    closable.closeAllConnections?.()
  })
}

/** Full-origin TCP proxy. Keeping T3 at the origin root preserves assets,
 * cookies, HTTP APIs, and WebSocket upgrades without rewriting its protocol. */
async function createRuntimeProxy(runtime: Runtime, remotePort: number): Promise<{ server: NetServer; port: number }> {
  const sockets = new Set<Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.once('close', () => sockets.delete(client))
    void openTunnelDuplex(runtime, remotePort).then((upstream) => {
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.pipe(upstream).pipe(client)
    }).catch((error) => {
      log.warn('[t3] failed to open runtime tunnel: %s', errorMessage(error))
      client.destroy()
    })
  })
  server.on('close', () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
  })
  return { server, port: await listen(server) }
}

export class T3HarnessManager {
  private readonly states = new Map<string, InstanceState>()
  private readonly panelHarness = new Map<string, string>()
  private readonly panelRoute = new Map<string, AgentHarnessPanelRequest['route']>()
  private readonly locatorHarness = new Map<string, string>()
  private readonly providerAuth = new Map<string, ProviderAuthState>()

  constructor() {
    const onDisconnected = runtimes.onDisconnected?.bind(runtimes)
    onDisconnected?.((runtimeId) => {
      const keys = [...this.states.entries()]
        .filter(([, state]) => state.runtimeId === runtimeId)
        .map(([key]) => key)
      void Promise.all(keys.map((key) => this.stopHarness(key)))
      for (const auth of this.providerAuth.values()) {
        if (auth.runtimeId !== runtimeId || auth.phase !== 'running') continue
        auth.phase = 'failed'
        auth.message = 'The runtime disconnected during sign-in.'
      }
    })
    onWindowClosed((windowId) => {
      for (const auth of this.providerAuth.values()) {
        if (auth.ownerWindowId === windowId && auth.phase === 'running') {
          this.cancelProviderAuth(auth.id, windowId)
        }
      }
    })
  }

  async startProviderAuth(
    request: AgentProviderAuthRequest,
    ownerWindowId: number,
  ): Promise<AgentProviderAuthSession> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(
      resolved.path,
      ownerWindowId,
      request.workspaceId,
    )
    const command = providerAuthCommand(request.providerId, request.provider)
    const id = `provider-auth-${randomUUID()}`
    const state: ProviderAuthState = {
      id,
      providerId: request.providerId,
      ownerWindowId,
      runtimeId: resolved.runtimeId,
      runtime: resolved.runtime,
      phase: 'running',
      output: '',
      rawOutput: '',
    }
    this.providerAuth.set(id, state)
    try {
      await resolved.runtime.process.create({
        id,
        cols: 96,
        rows: 30,
        cwd,
        command,
        scopeId: request.workspaceId,
        env: { TERM: 'xterm-256color' },
      }, (_id, chunk) => {
        const current = this.providerAuth.get(id)
        if (!current) return
        current.rawOutput = `${current.rawOutput}${chunk}`.slice(-32_768)
        current.output = cleanProviderAuthOutput(current.rawOutput).slice(-24_000)
        current.url = providerAuthUrl(current.rawOutput)
        current.code = providerAuthCode(current.rawOutput)
      }, (_id, exitCode) => {
        const current = this.providerAuth.get(id)
        if (!current || current.phase === 'cancelled') return
        current.phase = exitCode === 0 ? 'succeeded' : 'failed'
        current.message = exitCode === 0
          ? 'Sign-in completed.'
          : current.output.trim()
            ? `Sign-in exited with code ${exitCode}.`
            : 'Sign-in could not start. Make sure the provider CLI is installed on this runtime.'
      })
      return this.providerAuthSnapshot(state)
    } catch (error) {
      this.providerAuth.delete(id)
      throw new Error(`Could not start ${request.providerId} sign-in: ${errorMessage(error)}`)
    }
  }

  getProviderAuth(id: string, ownerWindowId: number): AgentProviderAuthSession {
    const state = this.ownedProviderAuth(id, ownerWindowId)
    return this.providerAuthSnapshot(state)
  }

  writeProviderAuth(id: string, ownerWindowId: number, data: string): void {
    const state = this.ownedProviderAuth(id, ownerWindowId)
    if (!state || state.phase !== 'running') throw new Error('Provider sign-in is not running')
    if (data.length > 256) throw new Error('Provider sign-in input is too long')
    state.runtime.process.write(id, data)
  }

  cancelProviderAuth(id: string, ownerWindowId: number): void {
    const state = this.ownedProviderAuth(id, ownerWindowId)
    if (state.phase === 'running') {
      state.phase = 'cancelled'
      state.message = 'Sign-in cancelled.'
      state.runtime.process.kill(id)
    }
  }

  async getProviderStatuses(
    request: AgentProviderStatusRequest,
    ownerWindowId: number,
  ): Promise<AgentProviderStatus[]> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(
      resolved.path,
      ownerWindowId,
      request.workspaceId,
    )
    const key = harnessKey(resolved.runtimeId, cwd)
    const instance = await this.ensureInstance(
      key,
      resolved.runtimeId,
      resolved.runtime,
      cwd,
      request.workspaceId,
    )
    const providerIds = Object.keys(PROVIDER_STATUS_CACHE) as AgentProviderId[]
    return await Promise.all(providerIds.map(async (providerId) => {
      const cachePath = runtimePath(
        instance.runtimeId,
        instance.baseDir,
        'caches',
        PROVIDER_STATUS_CACHE[providerId],
      )
      const snapshot = await this.readJsonObject(
        instance.runtime,
        cachePath,
        `${providerId} status`,
      )
      return providerStatusFromSnapshot(providerId, snapshot)
    }))
  }

  async providerSettingsOperation(request: AgentProviderStatusRequest & {
    operation: 'read' | 'save' | 'refresh' | 'update'
    patch?: Record<string, unknown>
    provider?: string
    instanceId?: string
  }, ownerWindowId: number): Promise<unknown> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(resolved.path, ownerWindowId, request.workspaceId)
    const key = harnessKey(resolved.runtimeId, cwd)
    const instance = await this.ensureInstance(key, resolved.runtimeId, resolved.runtime, cwd, request.workspaceId)
    const url = `http://127.0.0.1:${instance.proxyPort}`
    const cookies = await session.fromPartition(partitionFor(key)).cookies.get({ url })
    const call = (method: string, payload: unknown = {}) => settingsRpc(url,
      cookies.map(({ name, value }) => `${name}=${value}`).join('; '), method, payload)
    if (request.operation === 'save') {
      const allowed = new Set(['providers', 'providerInstances', 'enableProviderUpdateChecks',
        'providerHealthRefreshInterval', 'enableLegacyTokenStreaming', 'sidebarAutoSettleAfterDays',
        'sidebarAutoSettleOnMerge', 'textGenerationModelSelection'])
      const patch = request.patch ?? {}
      if (Object.keys(patch).some((field) => !allowed.has(field))) throw new Error('Unsupported agent setting')
      await call('server.updateSettings', { patch })
      await this.publishProviderProfile(key)
    }
    if (request.operation === 'refresh') await call('server.refreshProviders', {})
    if (request.operation === 'update') await call('server.updateProvider', {
      provider: request.provider, instanceId: request.instanceId,
    })
    const config = await call('server.getConfig')
    return { settings: config.settings, providers: config.providers }
  }

  async deleteConversation(request: AgentProviderStatusRequest & { threadId: string }, ownerWindowId: number): Promise<string> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(resolved.path, ownerWindowId, request.workspaceId)
    const key = harnessKey(resolved.runtimeId, cwd)
    const instance = await this.ensureInstance(key, resolved.runtimeId, resolved.runtime, cwd, request.workspaceId)
    const url = `http://127.0.0.1:${instance.proxyPort}`
    const cookies = await session.fromPartition(partitionFor(key)).cookies.get({ url })
    const response = await fetch(`${url}/api/orchestration/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
      body: JSON.stringify({ type: 'thread.delete', commandId: randomUUID(), threadId: request.threadId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`T3 conversation deletion returned HTTP ${response.status}`)
    return partitionFor(key)
  }

  async listConversations(request: AgentProviderStatusRequest, ownerWindowId: number): Promise<import('../../shared/t3Agent').T3Conversation[]> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(resolved.path, ownerWindowId, request.workspaceId)
    const key = harnessKey(resolved.runtimeId, cwd)
    const instance = await this.ensureInstance(key, resolved.runtimeId, resolved.runtime, cwd, request.workspaceId)
    const url = `http://127.0.0.1:${instance.proxyPort}`
    const cookies = await session.fromPartition(partitionFor(key)).cookies.get({ url })
    const response = await fetch(`${url}/api/orchestration/shell`, {
      headers: { Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ') },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`T3 conversations returned HTTP ${response.status}`)
    const snapshot = await response.json() as { threads: Array<{ id: string; title: string; updatedAt: string }> }
    return snapshot.threads.map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
  }

  async getPanelTarget(
    request: AgentHarnessPanelRequest,
    ownerWindowId: number,
  ): Promise<AgentHarnessPanelTarget> {
    const resolved = resolveLocator(request.cwd)
    const cwd = await resolved.runtime.validatePathStrict(
      resolved.path,
      ownerWindowId,
      request.workspaceId,
    )
    const key = harnessKey(resolved.runtimeId, cwd)
    this.locatorHarness.set(harnessKey(resolved.runtimeId, resolved.path), key)
    const instance = await this.ensureInstance(
      key,
      resolved.runtimeId,
      resolved.runtime,
      cwd,
      request.workspaceId,
    )
    // Startup and provider-profile publication already synchronize settings.
    // Reopening a webview must not recopy provider secrets (especially over SSH).
    if (!instance.environmentId) throw new Error('T3 environment descriptor did not include an environment ID')

    const previousKey = this.panelHarness.get(request.panelId)
    if (previousKey && previousKey !== key) {
      this.states.get(previousKey)?.instance?.panels.delete(request.panelId)
    }
    instance.panels.add(request.panelId)
    this.panelHarness.set(request.panelId, key)
    this.panelRoute.set(request.panelId, request.route ?? 'thread')

    const baseUrl = `http://127.0.0.1:${instance.proxyPort}`
    let url: string
    if (request.route === 'providers') {
      url = `${baseUrl}/settings/providers`
    } else if (request.threadId) {
      url = `${baseUrl}/${encodeURIComponent(instance.environmentId)}/${encodeURIComponent(request.threadId)}`
    } else {
      url = `${baseUrl}/`
    }

    return {
      url,
      partition: partitionFor(key),
      runtimeId: resolved.runtimeId,
      environmentId: instance.environmentId,
      threadId: request.threadId ?? null,
    }
  }

  panelClosed(panelId: string): void {
    const key = this.panelHarness.get(panelId)
    if (!key) return
    const route = this.panelRoute.get(panelId)
    this.panelHarness.delete(panelId)
    this.panelRoute.delete(panelId)
    this.states.get(key)?.instance?.panels.delete(panelId)
    if (route === 'providers') {
      setTimeout(() => {
        void this.publishProviderProfile(key).catch((error) => {
          log.warn('[t3] failed to publish provider settings: %s', errorMessage(error))
        })
      }, SETTINGS_FLUSH_DELAY_MS)
    }
    // The server intentionally remains alive. A turn can continue after its
    // panel closes, and the next panel on this checkout reuses it.
  }

  getStatus(cwd: string): AgentHarnessStatus {
    const { runtimeId, path: resolvedPath } = resolveLocator(cwd)
    const rawKey = harnessKey(runtimeId, resolvedPath)
    const state = this.states.get(this.locatorHarness.get(rawKey) ?? rawKey)
    return state ? { phase: state.phase, ...(state.message ? { message: state.message } : {}) } : { phase: 'stopped' }
  }

  async restart(cwdLocator: string): Promise<void> {
    const { runtimeId, path: resolvedPath } = resolveLocator(cwdLocator)
    const rawKey = harnessKey(runtimeId, resolvedPath)
    await this.stopHarness(this.locatorHarness.get(rawKey) ?? rawKey)
  }

  async disposeAll(): Promise<void> {
    for (const auth of this.providerAuth.values()) {
      if (auth.phase === 'running') auth.runtime.process.kill(auth.id)
    }
    this.providerAuth.clear()
    const providerHarnesses = new Set<string>()
    for (const [panelId, key] of this.panelHarness) {
      if (this.panelRoute.get(panelId) === 'providers') providerHarnesses.add(key)
    }
    await Promise.all(
      [...providerHarnesses].map((key) => this.publishProviderProfile(key).catch((error) => {
        log.warn('[t3] failed to publish provider settings during shutdown: %s', errorMessage(error))
      })),
    )
    await Promise.all([...this.states.keys()].map((key) => this.stopHarness(key)))
  }

  private providerAuthSnapshot(state: ProviderAuthState): AgentProviderAuthSession {
    return {
      id: state.id,
      providerId: state.providerId,
      phase: state.phase,
      output: state.output,
      ...(state.url ? { url: state.url } : {}),
      ...(state.code ? { code: state.code } : {}),
      ...(state.message ? { message: state.message } : {}),
    }
  }

  private ownedProviderAuth(id: string, ownerWindowId: number): ProviderAuthState {
    const state = this.providerAuth.get(id)
    if (!state || state.ownerWindowId !== ownerWindowId) {
      throw new Error('Provider sign-in session was not found')
    }
    return state
  }

  private async ensureInstance(
    key: string,
    runtimeId: string,
    runtime: Runtime,
    cwd: string,
    workspaceId: string,
  ): Promise<HarnessInstance> {
    const existing = this.states.get(key)
    if (existing?.instance && existing.phase === 'running') return existing.instance
    if (existing?.start) return await existing.start

    const state: InstanceState = { runtimeId, phase: 'starting' }
    const start = this.startInstance(key, runtimeId, runtime, cwd, workspaceId)
      .then((instance) => {
        state.phase = 'running'
        state.instance = instance
        state.start = undefined
        return instance
      })
      .catch((error) => {
        state.phase = 'error'
        state.message = errorMessage(error)
        state.start = undefined
        throw error
      })
    state.start = start
    this.states.set(key, state)
    return await start
  }

  private async startInstance(
    key: string,
    runtimeId: string,
    runtime: Runtime,
    cwd: string,
    workspaceId: string,
  ): Promise<HarnessInstance> {
    const harnessRoot = await runtime.file.harnessRoot()
    const paths = harnessPaths(runtimeId, harnessRoot, cwd)
    // FileHost validates the immediate parent before a recursive mkdir, so
    // create this host-owned state hierarchy one level at a time.
    await runtime.file.mkdir(paths.harnessRoot)
    await runtime.file.mkdir(paths.instancesRoot)
    await runtime.file.mkdir(paths.baseDir)
    const entryPath = this.resolveEntryPath(runtimeId)
    const bootstrapToken = randomBytes(24).toString('hex')
    const serverId = `t3-${createHash('sha256').update(key).digest('hex').slice(0, 8)}-${randomUUID().slice(0, 8)}`

    const seed: HarnessInstance = {
      key,
      runtimeId,
      cwd,
      runtime,
      serverId,
      remotePort: 0,
      proxy: net.createServer(),
      proxyPort: 0,
      baseDir: paths.baseDir,
      providerProfilePath: paths.providerProfilePath,
      providerSecretsDir: paths.providerSecretsDir,
      entryPath,
      bootstrapToken,
      environmentId: null,
      panels: new Set(),
    }
    await this.ensureLocalThreadMode(seed)
    const cateApi = await workspaceCateApi.ensureEndpoint(workspaceId)

    const bootstrap = JSON.stringify({
      mode: 'desktop',
      noBrowser: true,
      // T3CODE_PORT below has higher precedence and is allocated by Cate's
      // runtime server host. The schema still requires a valid bootstrap port.
      port: 3773,
      t3Home: paths.baseDir,
      host: '127.0.0.1',
      desktopBootstrapToken: bootstrapToken,
      tailscaleServeEnabled: false,
      tailscaleServePort: 3774,
    }) + '\n'

    let outputTail = ''
    const handle = await runtime.server.start({
      id: serverId,
      command: [
        harnessNodeExecutable(runtimeId, app.isPackaged),
        entryPath,
        '--bootstrap-fd',
        '0',
        '--auto-bootstrap-project-from-cwd',
      ],
      cwd,
      env: {
        T3CODE_HOME: paths.baseDir,
        T3CODE_HOST: '127.0.0.1',
        T3CODE_NO_BROWSER: 'true',
        ...(cateApi
          ? {
              CATE_API: `http://127.0.0.1:${cateApi.port}`,
              CATE_TOKEN: cateApi.token,
            }
          : { CATE_API: '', CATE_TOKEN: '' }),
      },
      portEnv: 'T3CODE_PORT',
      readyPath: READY_PATH,
      readyTimeoutMs: START_TIMEOUT_MS,
      bootstrapStdin: bootstrap,
      includeCateCli: true,
    }, (_id, stream, chunk) => {
      outputTail = `${outputTail}${chunk}`.slice(-8192)
      if (stream === 'stderr') log.debug('[t3:%s] %s', runtimeId, chunk.trimEnd())
    }, (_id, code, signal) => {
      const state = this.states.get(key)
      if (state?.instance?.serverId !== serverId) return
      state.phase = 'error'
      state.message = `T3 exited (code ${code ?? 'unknown'}, signal ${signal ?? 'none'})${outputTail.trim() ? `: ${outputTail.trim().slice(-500)}` : ''}`
      void closeServer(state.instance.proxy).catch(() => {})
      state.instance = undefined
    })

    let proxy: Awaited<ReturnType<typeof createRuntimeProxy>>
    try {
      proxy = await createRuntimeProxy(runtime, handle.port)
    } catch (error) {
      runtime.server.stop(serverId)
      throw error
    }
    const instance: HarnessInstance = {
      ...seed,
      remotePort: handle.port,
      proxy: proxy.server,
      proxyPort: proxy.port,
    }
    try {
      instance.environmentId = await this.readEnvironmentId(instance)
      await this.installBrowserSession(instance)
      log.info('[t3] running runtime=%s pid=%d remotePort=%d proxyPort=%d', runtimeId, handle.pid, handle.port, proxy.port)
      return instance
    } catch (error) {
      await closeServer(proxy.server).catch(() => {})
      runtime.server.stop(serverId)
      throw error
    }
  }

  private resolveEntryPath(runtimeId: string): string {
    const e2eEntryPath = process.env.CATE_E2E === '1'
      ? process.env.CATE_E2E_T3_ENTRY_PATH?.trim()
      : undefined
    if (runtimeId === 'local' && e2eEntryPath) return e2eEntryPath
    if (runtimeId !== 'local' || app.isPackaged) {
      return `${RUNTIME_INSTALL_ROOT_PLACEHOLDER}/t3/dist/bin.mjs`
    }
    return path.join(app.getAppPath(), 'node_modules', 't3', 'dist', 'bin.mjs')
  }

  private async ensureLocalThreadMode(instance: HarnessInstance): Promise<void> {
    const userdata = runtimePath(instance.runtimeId, instance.baseDir, 'userdata')
    const settingsPath = runtimePath(instance.runtimeId, userdata, 'settings.json')
    await instance.runtime.file.mkdir(userdata)

    const settings = await this.readJsonObject(instance.runtime, settingsPath, 'T3 settings') ?? {}
    let next = settings
    const profile = await this.readJsonObject(
      instance.runtime,
      instance.providerProfilePath,
      'T3 provider profile',
    )
    if (profile) {
      await this.copyProviderSecrets(
        instance.runtime,
        instance.runtimeId,
        instance.providerSecretsDir,
        runtimePath(instance.runtimeId, userdata, 'secrets'),
      )
      next = applyProviderProfile(settings, profile)
    }

    next = applyCateProviderDefaults(next)

    if (
      next.defaultThreadEnvMode === 'local'
      && next.enableAgentBrowserAccess === false
      && JSON.stringify(next) === JSON.stringify(settings)
    ) return
    next.defaultThreadEnvMode = 'local'
    next.enableAgentBrowserAccess = false
    await instance.runtime.file.writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`)
  }

  private async publishProviderProfile(key: string): Promise<void> {
    const source = this.states.get(key)?.instance
    if (!source) return
    const sourceUserdata = runtimePath(source.runtimeId, source.baseDir, 'userdata')
    const sourceSettingsPath = runtimePath(source.runtimeId, sourceUserdata, 'settings.json')
    const settings = await this.readJsonObject(source.runtime, sourceSettingsPath, 'T3 settings')
    if (!settings) return
    const profile = extractProviderProfile(settings)

    await this.copyProviderSecrets(
      source.runtime,
      source.runtimeId,
      runtimePath(source.runtimeId, sourceUserdata, 'secrets'),
      source.providerSecretsDir,
    )
    await source.runtime.file.writeFile(
      source.providerProfilePath,
      `${JSON.stringify(profile, null, 2)}\n`,
    )

    await Promise.all(
      [...this.states.values()]
        .map((state) => state.instance)
        .filter((instance): instance is HarnessInstance =>
          Boolean(instance && instance.key !== source.key && instance.runtimeId === source.runtimeId),
        )
        .map((instance) => this.ensureLocalThreadMode(instance)),
    )
  }

  private async copyProviderSecrets(
    runtime: Runtime,
    runtimeId: string,
    sourceDir: string,
    targetDir: string,
  ): Promise<void> {
    await runtime.file.mkdir(targetDir)
    const sourceEntries = await this.readDirectoryIfPresent(runtime, sourceDir)
    const targetEntries = await this.readDirectoryIfPresent(runtime, targetDir)

    for (const entry of targetEntries) {
      if (!entry.isDirectory && isProviderSecretFile(entry.name)) {
        await runtime.file.remove(entry.path)
      }
    }
    for (const entry of sourceEntries) {
      if (entry.isDirectory || !isProviderSecretFile(entry.name)) continue
      // FileHost.copy preserves T3's 0600 secret-file mode. Re-encoding via
      // writeBinary would create a new file with the host's ordinary umask.
      const copiedPath = await runtime.file.copy(entry.path, targetDir)
      // copy validates the destination on the owning host and returns its
      // canonical path, which can differ from targetDir through a symlink.
      // Only a collision-renamed filename would break T3's secret lookup.
      if ((runtimeId === 'local' ? path : path.posix).basename(copiedPath) !== entry.name) {
        throw new Error(`Provider secret copy chose an unexpected destination: ${copiedPath}`)
      }
    }
  }

  private async readDirectoryIfPresent(runtime: Runtime, directory: string) {
    try {
      return await runtime.file.readDir(directory)
    } catch (error) {
      if (this.isMissingFileError(error)) return []
      throw error
    }
  }

  private async readJsonObject(
    runtime: Runtime,
    filePath: string,
    label: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const parsed: unknown = JSON.parse(await runtime.file.readFile(filePath))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('root must be a JSON object')
      }
      return parsed as Record<string, unknown>
    } catch (error) {
      if (this.isMissingFileError(error)) return null
      throw new Error(`Cannot read ${label}: ${errorMessage(error)}`)
    }
  }

  private isMissingFileError(error: unknown): boolean {
    return /ENOENT|not found|does not exist/i.test(errorMessage(error))
  }

  private async readEnvironmentId(instance: HarnessInstance): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${instance.proxyPort}${READY_PATH}`)
    if (!response.ok) throw new Error(`T3 environment descriptor returned HTTP ${response.status}`)
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') throw new Error('T3 environment descriptor was malformed')
    const environmentId = (body as { environmentId?: unknown }).environmentId
    if (typeof environmentId !== 'string' || environmentId.length === 0) {
      throw new Error('T3 environment descriptor did not include an environment ID')
    }
    return environmentId
  }

  private async installBrowserSession(instance: HarnessInstance): Promise<void> {
    const baseUrl = `http://127.0.0.1:${instance.proxyPort}`
    const response = await fetch(`${baseUrl}/api/auth/browser-session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: instance.bootstrapToken }),
    })
    if (!response.ok) throw new Error(`T3 browser session bootstrap returned HTTP ${response.status}`)
    const setCookie = response.headers.get('set-cookie')
    if (!setCookie) throw new Error('T3 browser session bootstrap returned no cookie')
    const pair = setCookie.split(';', 1)[0]
    const equals = pair.indexOf('=')
    if (equals <= 0) throw new Error('T3 browser session cookie was malformed')
    await session.fromPartition(partitionFor(instance.key)).cookies.set({
      url: baseUrl,
      name: pair.slice(0, equals),
      value: pair.slice(equals + 1),
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    })
  }

  private async stopHarness(key: string): Promise<void> {
    const state = this.states.get(key)
    this.states.delete(key)
    for (const [panelId, ownerKey] of this.panelHarness) {
      if (ownerKey === key) {
        this.panelHarness.delete(panelId)
        this.panelRoute.delete(panelId)
      }
    }
    for (const [locatorKey, ownerKey] of this.locatorHarness) {
      if (ownerKey === key) this.locatorHarness.delete(locatorKey)
    }
    const instance = state?.instance ?? (state?.start ? await state.start.catch(() => undefined) : undefined)
    if (!instance) return
    await closeServer(instance.proxy).catch(() => {})
    instance.runtime.server.stop(instance.serverId)
  }
}

export const t3HarnessManager = new T3HarnessManager()
