// The daemon's composition root: the one file that imports every module's
// runtime side, builds the services with their deps and registers their
// capabilities on the rpc server (architecture 7.1, conventions "Runtime
// module pattern").
//
// The workspace, service and panel modules are built in
// `compose/workspace.ts`; this file owns the daemon around them.

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createLogger, type Logger } from '@kernel/log/contract'
import { lifecycle as defaultLifecycle, type LifecycleBus } from '@kernel/lifecycle/runtime'
import { RpcError } from '@kernel/rpc/contract'
import { RpcServer, type CapabilityImpl } from '@kernel/rpc/runtime'
import { settingsCapability } from '@kernel/settings/contract'
import { createSettingsHandlers, createWorkspaceSettingsStore } from '@kernel/settings/runtime'
import { RUNTIME_STOP_DEADLINE_MS, runtimeIdFromCanonicalRoot, type RuntimeEndpoints } from '@runtime/data/contract'
import { canonicalRoot, cateHome, ensureLocalEndpoint, workspaceDataDir } from '@runtime/data/node'
import {
  acquireRuntimeSocket,
  ensureDataDir,
  ensureRuntimeKeyPair,
  overlappingRuntime,
  openSecretsFile,
  writeRuntimeInfo,
  type DataPaths,
} from '@runtime/data/runtime'
import { DEFAULT_CATE_CONNECT_URL } from '@runtime/connect/contract'
import { pairingCapability } from '@runtime/pairing/contract'
import { openPairingsFile, PairingService, pairingCapabilityImpl } from '@runtime/pairing/runtime'
import { powerCapability } from '@runtime/power/contract'
import { createPowerService, powerCapabilityImpl } from '@runtime/power/runtime'
import { pushCapability } from '@runtime/push/contract'
import { createPushService, openPushFile, pushCapabilityImpl } from '@runtime/push/runtime'
import { fingerprint, hexToBytes, networkIdOf } from '@runtime/security/contract'
import { createServerHost, reapOrphanServers, serverCapabilityImpl, type ServerHost } from '@runtime/server/runtime'
import type { PeerConnectionFactory, WebSocketFactory } from '@runtime/transports/contract'
import { loadNodePeerConnection, nodeWebSocketFactory } from '@runtime/transports/node'
import { createNetworkPeers, serveLocal, type SameNetworkOptions } from '@runtime/transports/runtime'
import { tunnelCapability } from '@runtime/tunnel/contract'
import { tunnelCapabilityImpl } from '@runtime/tunnel/runtime'
import { serverCapability } from '@runtime/server/contract'
import type { PanelRuntime } from '@panels/runtime'
import { applyLoginEnv, prependPath } from '@services/terminal/runtime'
import { withoutInheritedHookIdentity } from '@services/agents/runtime'
import { installDirFromExecPath, installLayout, RUNTIME_BUILD, RUNTIME_VERSION, runtimeCapability, type NestedRefusal, type ServeArgs } from './contract'
import { composeWorkspace, type Workspace } from './compose/workspace'
import { ensureRuntimeInstalled } from './node'
import {
  createBusyRegistry,
  createLifetime,
  createNetworkAccess,
  createPerfSampler,
  runtimeCapabilityImpl,
  type BusyRegistry,
  type NetworkAccess,
} from './runtime'

type StopReason =
  | { kind: 'signal' | 'stop' | 'idle' }
  | { kind: 'update'; version: string; installDir: string }

export interface ServeOptions {
  root: string
  network?: ServeArgs['network']
  /** The user's home; `.cate/` lives under it. Default `os.homedir()`. */
  home?: string
  version?: string
  /** The install this daemon runs from. Default: derived from its Node. */
  installDir?: string
  lifecycle?: LifecycleBus
  log?: Logger
  lifetime?: { graceMs?: number; pollMs?: number }
  /** For `runtime.update` downloads. */
  fetch?: typeof fetch
  /** Same-network listener overrides (tests bind to loopback, skip mDNS). */
  lan?: Pick<SameNetworkOptions, 'host' | 'port' | 'advertise' | 'addresses'>
  /** Cate Connect; default `CATE_CONNECT_URL` or the public service. */
  connect?: { url?: string; webSocket?: WebSocketFactory; peerConnection?: () => Promise<PeerConnectionFactory> }
  /** Panel types; default every panel in `@panels/runtime`. */
  panels?: readonly PanelRuntime[]
  /** Test seam: runs before the workspace restores. */
  beforeStart?: () => Promise<void>
}

export interface Daemon {
  readonly runtimeId: string
  /** The id on the network, from the runtime key (`networkIdOf`). */
  readonly networkId: string
  readonly root: string
  readonly paths: DataPaths
  readonly endpoint: string
  readonly rpc: RpcServer
  readonly busy: BusyRegistry
  readonly servers: ServerHost
  readonly pairing: PairingService
  readonly network: NetworkAccess
  readonly workspace: Workspace
  stop(reason: StopReason): Promise<void>
  /** Resolves once the runtime has stopped and released its socket, or
   *  after RUNTIME_STOP_DEADLINE_MS when its shutdown is stuck. */
  readonly stopped: Promise<StopReason>
}

export type ServeResult =
  | { kind: 'serving'; daemon: Daemon }
  /** Another daemon holds this workspace's socket. */
  | { kind: 'running'; runtimeId: string; endpoint: string }
  /** A live runtime's root contains this one or lies inside it. The socket
   *  refuses every client with `message` until `closed` resolves. */
  | { kind: 'nested'; message: string; closed: Promise<void> }

/** How long a nested runtime stays up to tell clients why it refuses them. */
const NESTED_REFUSAL_MS = 10_000

/** Once per daemon process, before serving: PTYs and servers inherit the
 *  login shell's environment. */
export async function prepareDaemonProcess(): Promise<void> {
  await applyLoginEnv()
}

export async function serveWorkspace(options: ServeOptions): Promise<ServeResult> {
  const home = options.home ?? os.homedir()
  const version = options.version ?? RUNTIME_VERSION
  const lifecycle = options.lifecycle ?? defaultLifecycle
  const log = options.log ?? createLogger('daemon')
  const installDir = options.installDir ?? installDirFromExecPath(process.execPath, process.platform)

  const root = await canonicalRoot(options.root)
  const runtimeId = runtimeIdFromCanonicalRoot(root)
  const paths = await ensureDataDir(workspaceDataDir(runtimeId, home))

  const lock = await acquireRuntimeSocket(paths.dir, runtimeId)
  if (lock.kind === 'running') return { kind: 'running', runtimeId, endpoint: lock.endpoint }
  const endpoint = lock.endpoint
  // The one place nesting is blocked: every client starts a workspace here.
  const overlapping = await overlappingRuntime(root, home)
  if (overlapping) {
    const message = overlapping.root.length < root.length
      ? `${root} is inside the workspace ${overlapping.root}, which is already open in Cate. Open that workspace instead, or close it first.`
      : `${root} contains the workspace ${overlapping.root}, which is already open in Cate. Close that workspace first.`
    const data: NestedRefusal = { nested: { root: overlapping.root } }
    const refusing = serveLocal(lock.server, new RpcServer({
      version,
      build: RUNTIME_BUILD,
      lifecycle,
      acceptHello: () => { throw new RpcError('rejected', message, data) },
    }))
    refusing.open()
    const closed = new Promise<void>((resolve) => setTimeout(() => void refusing.close().then(resolve), NESTED_REFUSAL_MS))
    return { kind: 'nested', message, closed }
  }
  // A too-long data dir is reached through a /tmp symlink (data/node); keep it
  // there for the CLI's CATE_SOCKET even if a tmp cleaner removes it.
  const relink = setInterval(() => {
    ensureLocalEndpoint(paths.dir, runtimeId).catch((err: Error) => log.warn('socket link: %s', err.message))
  }, 60 * 60_000)
  relink.unref()
  let workspace: Workspace | undefined
  const rpc = new RpcServer({ version, build: RUNTIME_BUILD, lifecycle, acceptHello: (hello) => workspace?.acceptHello(hello) })
  const listener = serveLocal(lock.server, rpc)
  const writeInfo = (remote: Omit<RuntimeEndpoints, 'local'> = {}) => writeRuntimeInfo(paths.dir, {
    runtimeId,
    root,
    pid: process.pid,
    version,
    ...(RUNTIME_BUILD ? { build: RUNTIME_BUILD } : {}),
    protocol: [rpc.protocol[0], rpc.protocol[1]],
    endpoints: { local: endpoint, ...remote },
  })
  // Written now, not once the workspace has restored: nesting checks and
  // install pruning read it to see this runtime while it starts.
  await writeInfo()

  const secrets = openSecretsFile(paths.dir)
  const keys = await ensureRuntimeKeyPair(secrets)
  // Paired devices, Cate Connect and mDNS know the runtime by the id its key
  // derives; the path's runtimeId names only its data dir and socket.
  const networkId = networkIdOf(keys.publicKey)
  const settings = createWorkspaceSettingsStore({ dataDir: paths.dir })
  if (options.network) settings.set('runtimeNetwork', options.network)

  const busy = createBusyRegistry()
  const perf = createPerfSampler()

  const serversPidFile = path.join(paths.dir, 'servers.json')
  reapOrphanServers(serversPidFile)
  const cateBin = installLayout(installDir, process.platform).cateBin
  const servers = createServerHost({
    pidFile: serversPidFile,
    installDir,
    baseEnv: () => withoutInheritedHookIdentity(process.env),
    withCateCli: (env) => ({ ...env, ...prependPath(env, cateBin) }),
  })

  const pairingsFile = openPairingsFile(paths.dir)
  const pairing = new PairingService({
    runtimePublicKey: keys.publicKey,
    store: pairingsFile,
    addresses: () => network.addresses(),
  })

  const ws = composeWorkspace({
    root,
    runtimeId,
    paths,
    endpoint,
    installDir,
    rpc,
    lifecycle,
    settings,
    secrets,
    servers,
    busy,
    log,
    // `cate serve` (network on from the command line) trusts what it serves.
    trustOnStart: options.network !== undefined,
    countPerf: (name) => perf.count(name),
    ...(options.panels ? { panels: options.panels } : {}),
  })
  workspace = ws

  const power = createPowerService({ busy: busy.busy, onError: (err) => log.warn('keep-awake helper failed: %s', err.message) })

  // Agent notifications reach paired devices through Cate Connect while
  // they are away; an unpaired device stops getting them.
  const pushFile = openPushFile(paths.dir)
  const push = createPushService({
    runtimeId: networkId,
    workspace: path.basename(root),
    store: pushFile,
    sender: () => network.registration(),
    log: log.child('push'),
  })
  const offPushEvents = ws.agents.notifications.subscribe((event) => {
    push.notify(event).catch((err: Error) => log.warn('push failed: %s', err.message))
  })
  const offPushRevoked = pairing.onRevoked((publicKey) => push.forgetDevice(fingerprint(hexToBytes(publicKey))))

  let resolveStopped!: (reason: StopReason) => void
  const stopped = new Promise<StopReason>((resolve) => { resolveStopped = resolve })
  let stopping: Promise<void> | null = null


  const stoppingListeners = new Set<(reason: StopReason['kind']) => void>()
  const stop = (reason: StopReason): Promise<void> => {
    stopping ??= (async () => {
      log.info('stopping (%s)', reason.kind)
      // The socket closes early: a stuck step below would leave a process
      // that serves nobody but still holds the workspace's files. The
      // process exits once `stopped` resolves (main.ts).
      const deadline = setTimeout(() => {
        log.warn('stop did not finish within %d ms; exiting anyway', RUNTIME_STOP_DEADLINE_MS)
        resolveStopped(reason)
      }, RUNTIME_STOP_DEADLINE_MS)
      deadline.unref()
      // Clients learn why before their connections close.
      for (const listener of [...stoppingListeners]) listener(reason.kind)
      if (stoppingListeners.size > 0) await new Promise((resolve) => setTimeout(resolve, 50))
      lifetime.dispose()
      clearInterval(relink)
      // Stop accepting, then sessions and modules, then state files.
      await network.dispose()
      rpc.close()
      await listener.close()
      await lifecycle.emitShutdown(reason.kind)
      await ws.shutdown()
      servers.killAll()
      power.dispose()
      offPushEvents()
      offPushRevoked()
      await removeSocket(endpoint)
      settings.dispose()
      pairingsFile.dispose()
      pushFile.dispose()
      secrets.dispose()
      clearTimeout(deadline)
      resolveStopped(reason)
    })()
    return stopping
  }

  rpc.register(runtimeCapability, runtimeCapabilityImpl({
    runtimeId,
    root,
    version,
    rpc,
    perf,
    busy: busy.busy,
    stop: () => void stop({ kind: 'stop' }),
    onStopping(listener) {
      stoppingListeners.add(listener)
      return () => { stoppingListeners.delete(listener) }
    },
    async update(next, onProgress) {
      const dir = await ensureRuntimeInstalled({ ...next, cateHome: cateHome(home), fetch: options.fetch, onProgress })
      setTimeout(() => void stop({ kind: 'update', version: next.build ?? next.version, installDir: dir }), 20)
    },
  }))
  rpc.register(settingsCapability, settingsCapabilityImpl(createSettingsHandlers(settings)))
  rpc.register(pairingCapability, pairingCapabilityImpl(pairing))
  rpc.register(tunnelCapability, tunnelCapabilityImpl())
  rpc.register(powerCapability, powerCapabilityImpl(power))
  rpc.register(pushCapability, pushCapabilityImpl(push))
  rpc.register(serverCapability, serverCapabilityImpl({ host: servers, trust: ws.trust }))

  const clients = () => rpc.connections().filter((c) => c.client !== null).length
  const lifetime = createLifetime({
    settings: {
      runtimeLifetime: () => settings.get('runtimeLifetime'),
      runtimeNetwork: () => settings.get('runtimeNetwork'),
      subscribe: (cb) => settings.subscribe(() => cb()),
    },
    busy: busy.busy,
    clients,
    // The rpc server announces a gone client before dropping its connection,
    // so count once it is gone.
    onClientsChanged: (cb) => {
      const later = () => { setTimeout(cb, 0) }
      const offConnected = lifecycle.onClientConnected(later)
      const offGone = lifecycle.onClientGone(later)
      return () => { offConnected(); offGone() }
    },
    stop: () => void stop({ kind: 'idle' }),
    ...options.lifetime,
  })

  const network = createNetworkAccess({
    runtimeKeys: keys,
    peers: createNetworkPeers({ rpc, runtimeKeys: keys, pairing, log: log.child('network') }),
    mode: () => settings.get('runtimeNetwork'),
    subscribe: (cb) => settings.subscribe(() => cb()),
    sameNetwork: options.lan,
    connect: {
      url: options.connect?.url ?? process.env.CATE_CONNECT_URL ?? DEFAULT_CATE_CONNECT_URL,
      webSocket: options.connect?.webSocket ?? nodeWebSocketFactory,
      peerConnection: options.connect?.peerConnection ?? loadNodePeerConnection,
    },
    onEndpointsChanged: () => {
      writeInfo(network.endpoints()).catch((err: Error) => log.warn('could not write runtime.json: %s', err.message))
    },
    log: log.child('network'),
  })
  await options.beforeStart?.()
  await ws.start()
  await network.settled()
  await writeInfo(network.endpoints())
  listener.open()
  log.info('serving %s as %s on %s', root, runtimeId, endpoint)

  return {
    kind: 'serving',
    daemon: { runtimeId, networkId, root, paths, endpoint, rpc, busy, servers, pairing, network, workspace: ws, stop, stopped },
  }
}

function settingsCapabilityImpl(handlers: ReturnType<typeof createSettingsHandlers>): CapabilityImpl<typeof settingsCapability> {
  return {
    getAll: () => handlers.getAll(),
    set: (params) => handlers.set(params),
    subscribe: (_params, sink) => handlers.subscribe((event) => sink.emit(event)),
  }
}

async function removeSocket(endpoint: string): Promise<void> {
  if (process.platform === 'win32') return
  try {
    if ((await fs.lstat(endpoint)).isSocket()) await fs.rm(endpoint, { force: true })
  } catch { /* already gone */ }
}
