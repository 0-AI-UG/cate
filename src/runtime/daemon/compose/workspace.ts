// The workspace half of the composition root: builds the workspace, service
// and panel modules with their deps, wires them to each other and registers
// their capabilities and `cate` API handlers. `entry.ts` owns the daemon
// around it (socket, network, lifetime, power).

import path from 'node:path'
import type { HelloMessage } from '@kernel/rpc/contract'
import { RpcError } from '@kernel/rpc/contract'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import type { LifecycleBus } from '@kernel/lifecycle/contract'
import { apiCapability } from '@kernel/api/contract'
import { ApiRouter, ApiTokenRegistry, acceptCallerHello, apiCapabilityImpl, registerKernelApi } from '@kernel/api/runtime'
import type { WorkspaceSettingsStore } from '@kernel/settings/runtime'
import type { WorkspaceSettings } from '@panels/settings'
import type { DataPaths, openSecretsFile } from '@runtime/data/runtime'
import type { ServerHost } from '@runtime/server/runtime'
import { workspaceCapability } from '@workspace/lifecycle/contract'
import { createTrustGate, workspaceCapabilityImpl, workspaceInfo } from '@workspace/lifecycle/runtime'
import { documentCapability, presenceCapability, type PanelRecord } from '@workspace/document/contract'
import {
  createDocumentService,
  createPresence,
  documentCapabilityImpl,
  presenceCapabilityImpl,
  registerDocumentApi,
} from '@workspace/document/runtime'
import { fileCapability, searchCapability } from '@workspace/files/contract'
import {
  createFilesRuntime,
  ensureCateGitignore,
  fileCapabilityImpl,
  pathCompareKey,
  realpathAllowingMissing,
  searchCapabilityImpl,
} from '@workspace/files/runtime'
import { vcsCapability } from '@workspace/repository/contract'
import { createRepositoryRuntime, vcsCapabilityImpl } from '@workspace/repository/runtime'
import { skillsCapability, type SkillTarget } from '@workspace/skills/contract'
import { createSkillsRuntime, skillsCapabilityImpl } from '@workspace/skills/runtime'
import { createConnectedEditors, type SharedEditor } from '@workspace/relations/runtime'
import { RELATION_CONTEXT_MODE_FIELD, type RelationRoleOf } from '@workspace/relations/contract'
import { processCapability } from '@services/terminal/contract'
import {
  cateCliEnvContributor,
  createTerminalService,
  nodePtySpawn,
  processCapabilityImpl,
  snapshotProcessTree,
} from '@services/terminal/runtime'
import { browserDataCapability } from '@services/browser/contract'
import { browserDataCapabilityImpl, createBrowserDataRuntime } from '@services/browser/runtime'
import { t3Capability } from '@services/t3/contract'
import { createT3Runtime, t3CapabilityImpl, type T3PtyHost } from '@services/t3/runtime'
import { AGENTS, agentsCapability } from '@services/agents/contract'
import { agentApi } from '@services/agents/contract/api'
import { notificationsCapability } from '@workspace/notifications/contract'
import { createNotifications, notificationsCapabilityImpl } from '@workspace/notifications/runtime'
import { CATE_API } from '@panels/api'
import {
  createAgentsRuntime,
  withoutInheritedHookIdentity,
  type AgentStartPorts,
  type AgentsDocument,
  type AgentsRuntime,
} from '@services/agents/runtime'
import { sessionCapability, surfaceCapability } from '@panels/framework/contract'
import {
  createPanelFactory,
  createPanelRegistry,
  createSessionHost,
  createSurfaceBroker,
  sessionCapabilityImpl,
  type SurfaceBroker,
} from '@panels/framework/runtime'
import { PANEL_RUNTIMES, type PanelPorts, type PanelRuntime, type PanelServices } from '@panels/runtime'
import { createChatThreads } from '@panels/chat/runtime'
import { installLayout } from '../contract'
import type { BusyRegistry } from '../runtime'
import { onQuarantine, quarantinedFiles, type Quarantined } from '@kernel/state/node'

export interface WorkspaceDeps {
  root: string
  runtimeId: string
  paths: DataPaths
  /** The local socket: `CATE_SOCKET` for terminals and harnesses. */
  endpoint: string
  installDir: string
  rpc: RpcServer
  lifecycle: LifecycleBus
  settings: WorkspaceSettingsStore<WorkspaceSettings>
  secrets: ReturnType<typeof openSecretsFile>
  servers: ServerHost
  busy: BusyRegistry
  log: Logger
  /** `cate serve` trusts the workspace it serves. */
  trustOnStart: boolean
  /** Panel types; default `PANEL_RUNTIMES`. */
  panels?: readonly PanelRuntime[]
  /** Counts work toward `runtime.perf` counters. */
  countPerf?: (name: string) => void
}

export type Workspace = ReturnType<typeof composeWorkspace>

export function composeWorkspace(deps: WorkspaceDeps) {
  const { root, paths, settings, rpc, log } = deps
  const layout = installLayout(deps.installDir, process.platform)
  const baseEnv = () => withoutInheritedHookIdentity(process.env)
  const offs: (() => void)[] = []

  // ---- Workspace --------------------------------------------------------------

  const trust = createTrustGate({ file: paths.trust, trustOnStart: deps.trustOnStart })
  const files = createFilesRuntime({ root, dataPaths: paths, log: log.child('files') })
  const document = createDocumentService({ file: paths.document, log: log.child('document') })
  const presence = createPresence({ lifecycle: deps.lifecycle })
  const prepareCateDir = (cateDir: string) => ensureCateGitignore(path.dirname(cateDir))

  const checkoutKeys = async (): Promise<Map<string, string>> => {
    const all = [root, ...files.paths.checkouts()]
    const keys = await Promise.all(all.map(async (dir) => pathCompareKey(await realpathAllowingMissing(dir))))
    return new Map(keys.map((key, i) => [key, all[i]]))
  }
  /** The root or one of its worktree checkouts, canonicalized. */
  const resolveCheckout = async (cwd: string | undefined): Promise<string> => {
    if (!cwd) return root
    const real = await files.paths.strict(cwd)
    const checkout = (await checkoutKeys()).get(pathCompareKey(real))
    if (!checkout) throw new RpcError('rejected', `${cwd} is not a checkout of this workspace`)
    return checkout
  }

  // Skills sync into new checkouts, so the repository reaches skills late.
  let syncCheckout: ((checkout: string) => Promise<unknown>) | undefined
  const repository = createRepositoryRuntime({
    root,
    env: baseEnv,
    trust,
    paths: {
      resolveDir: (dir) => files.paths.strict(dir),
      addCheckout: (p) => files.paths.addCheckout(p),
      removeCheckout: (p) => files.paths.removeCheckout(p),
    },
    document: {
      apply: async (op) => { document.apply(op) },
      get: () => document.get(),
    },
    settings: { get: (key) => settings.get(key) },
    log: log.child('repository'),
    watch: (dir, onChange) => files.watch(dir, (changedPath) => onChange(changedPath)),
    prepareCateDir,
    onWorktreeCreated: async (meta) => { await syncCheckout?.(meta.path) },
  })

  const skillTargets: SkillTarget[] = AGENTS.flatMap((agent) => agent.skills
    ? [{
        id: agent.skills.targetId,
        label: agent.skills.label ?? agent.displayName,
        baseSegments: agent.skills.baseSegments,
        ...(agent.skills.mirrorBaseSegments ? { mirrorBaseSegments: agent.skills.mirrorBaseSegments } : {}),
        layout: agent.skills.layout,
        bundledResources: agent.skills.bundledResources,
        nameMatchesDir: agent.skills.nameMatchesDir,
        ...(agent.skills.beta ? { beta: true } : {}),
      }]
    : [])
  const skills = createSkillsRuntime({
    root,
    dataPaths: paths,
    trust,
    targets: skillTargets,
    bundledSkillsDir: layout.skills,
    listCheckouts: async () => files.paths.checkouts(),
    ensureCateGitignore: prepareCateDir,
    log: log.child('skills'),
  })
  syncCheckout = (checkout) => skills.syncCheckout(checkout)

  // Sessions and panel types come later; both are looked up when needed.
  let sessionOf: (panelId: string) => unknown = () => undefined
  let relationRole: RelationRoleOf = () => undefined
  const connectedEditors = createConnectedEditors({
    document: { get: () => document.get(), subscribe: (listener) => document.subscribe(() => listener()) },
    enabled: () => settings.get('panelRelationsEnabled'),
    onEnabledChange: (listener) => settings.subscribe((_values, patch) => {
      if ('panelRelationsEnabled' in patch) listener()
    }),
    editor: (panelId) => sharedEditor(sessionOf(panelId)),
    relationRole: (type) => relationRole(type),
  })

  // ---- The `cate` API ---------------------------------------------------------

  const tokens = new ApiTokenRegistry()
  // Sessions come later; the router only calls them once serving.
  let host: ReturnType<typeof createSessionHost> | undefined
  const router = new ApiRouter({
    namespaces: CATE_API,
    document: {
      panel: (id) => apiPanel(document.get().panels[id]),
      panels: () => Object.values(document.get().panels).map((record) => apiPanel(record)!),
    },
    presence,
    sessions: {
      handleApi: (panelId, method, args, ctx) => {
        if (!host) throw new RpcError('gone', `panel ${panelId} is gone`)
        return host.handleApi(panelId, method, args, ctx)
      },
    },
    settings: { get: (key) => settings.get(key as never) },
    tokens,
  })
  // A removed panel's CLI tokens die with it.
  offs.push(document.subscribe(({ before, doc }) => {
    for (const id of Object.keys(before.panels)) if (!doc.panels[id]) tokens.revokePanel(id)
  }))

  // ---- Services ---------------------------------------------------------------

  const terminal = createTerminalService({
    root,
    logDir: paths.terminalLogs,
    trust,
    settings: {
      getAll: () => settings.getAll(),
      subscribe: (listener) => settings.subscribe((values) => listener(values)),
    },
    log: log.child('terminal'),
    env: baseEnv,
    resolveCwd: (cwd) => files.paths.cwd(cwd),
    // Background cadence while no connected client has the person's attention.
    attended: () => presence.clients().some((client) => client.attentive),
    ...(deps.countPerf ? { countPerf: deps.countPerf } : {}),
  })
  offs.push(terminal.registerEnvContributor(cateCliEnvContributor({
    socketPath: deps.endpoint,
    mintToken: (panelId) => tokens.issue({ kind: 'cli', panelId }).token,
    binDir: layout.cateBin,
  })))

  const browserData = createBrowserDataRuntime({
    dataPaths: paths,
    secrets: deps.secrets,
    paths: { validate: (p) => files.paths.strict(p) },
  })

  // Notification events: agents and `cate.ui.notify` publish, clients and
  // push delivery follow.
  const notifications = createNotifications()
  // A state file that could not be read was reset; the person hears of it,
  // with where the old one went, even when no client was there yet.
  const quarantineWarning = ({ file, backup }: Quarantined): void => notifications.keep({
    kind: 'cate.ui.notify',
    title: 'A Cate file could not be read',
    body: `${file} was reset to its defaults. The unreadable file was kept as ${backup}.`,
    level: 'warning',
  })
  for (const entry of quarantinedFiles()) quarantineWarning(entry)
  offs.push(onQuarantine(quarantineWarning))

  // Which thread each chat panel shows, from the document, for the agents
  // service's t3 runner.
  let broker: ReturnType<typeof createSurfaceBroker> | undefined
  const chatThreads = createChatThreads({ root, document, surfaces: () => broker })
  offs.push(chatThreads.dispose)
  // Terminal panels provide these once the session host exists.
  const ports: PanelPorts = {}
  const agentTerminals = lateAgentTerminals(() => ports.agentTerminals)

  // The t3 harness reports its edits to the agents service, created next.
  let agents: AgentsRuntime | undefined
  const harnessTokens = new Map<string, string>()
  const ptyHost: T3PtyHost = {
    async spawn({ file, args, cwd, env, cols, rows }, onData, onExit) {
      const pty = await nodePtySpawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env: { ...baseEnv(), ...env } })
      pty.onData(onData)
      pty.onExit(({ exitCode }) => onExit(exitCode))
      return { write: (data) => pty.write(data), kill: () => pty.kill() }
    },
  }
  const t3 = createT3Runtime({
    root,
    t3Root: paths.t3,
    trust,
    resolveCheckout,
    server: deps.servers,
    pty: ptyHost,
    harness: { node: layout.node, entry: layout.t3 },
    cateSocket: deps.endpoint,
    mintHarnessToken(checkout) {
      const previous = harnessTokens.get(checkout)
      if (previous) tokens.revoke(previous)
      const { token } = tokens.issue({ kind: 'harness' })
      harnessTokens.set(checkout, token)
      return token
    },
    harnessEnv: (harness) => agents?.changeCaptureEnv(harness) ?? Promise.resolve({}),
    harnessStopped: (id) => agents?.releaseChangeCapture(id),
    log: log.child('t3'),
  })

  agents = createAgentsRuntime({
    root,
    agentsDir: paths.agents,
    trust,
    settings: {
      agentHookInjection: () => settings.get('agentHookInjection'),
      panelRelationsEnabled: () => settings.get('panelRelationsEnabled'),
    },
    document: agentsDocument(document),
    resolveCheckout,
    snapshot: snapshotProcessTree,
    notify: (event) => notifications.publish(event),
    watchStatus: (cwd, listener) => repository.monitors.subscribe(cwd, listener),
    flushConnected: (panelId) => connectedEditors.flush(panelId),
    relationRole: (type) => relationRole(type),
    log: log.child('agents'),
    terminal,
    t3,
    chatThreads,
    start: {
      terminals: agentTerminals,
      // The panel factory exists once panel types are attached, before any call.
      createChat: ({ placement, ...options }) => factory.createPanel('chat', { ...options, ...placement }),
      worktrees: {
        async create(name) {
          const meta = await repository.createWorktree({ branch: name })
          return { id: meta.id, path: meta.path }
        },
        async remove(worktreeId) {
          await repository.removeWorktree({ worktreeId, force: true, deleteBranch: true })
        },
      },
      t3: {
        providerModels: () => t3.providerModels(),
        startThread: (params) => t3.startThread(params),
        async stopThread(params) {
          await t3.interruptTurn(params).catch(() => {})
          await t3.deleteConversation(params)
        },
      },
    },
  })
  const agentsRuntime = agents

  offs.push(deps.busy.contribute(() => terminal.busy()))
  offs.push(deps.busy.contribute(() => agentsRuntime.busy().length > 0))
  offs.push(deps.busy.contribute(() => t3.busy()))

  // `cate.ui.notify` reaches clients on the agents notification stream.
  offs.push(registerKernelApi(router, { publishNotification: (event) => notifications.publish(event) }))
  offs.push(router.registerService(agentApi, agentsRuntime.apiHandlers()))

  // ---- Panels -----------------------------------------------------------------

  const services: PanelServices = {
    root,
    settings,
    document,
    files,
    repository,
    connectedEditors,
    terminal,
    browserData,
    t3,
    agents: agentsRuntime,
  }
  const modules = (deps.panels ?? PANEL_RUNTIMES).map((panel) => panel(services))
  const registry = createPanelRegistry(modules.map(({ definition, session }) => ({ definition, session })))
  relationRole = (type) => registry.get(type)?.definition.relation
  broker = createSurfaceBroker({ presence })
  host = createSessionHost({
    document,
    registry,
    surfaces: broker,
    sessionFile: (panelId) => paths.session(panelId),
    log: log.child('sessions'),
  })
  const sessions = host
  sessionOf = (panelId) => sessions.session(panelId)
  // A client's removal that would lose a panel's work is refused `dirty`.
  document.guardRemovals((removing, discard) => sessions.checkRemoval(removing, discard))
  const factory = createPanelFactory({ document, registry })
  for (const module of modules) {
    const provided = module.attach?.({ host, factory, router, surfaces: broker, rpc })
    if (provided?.agentTerminals) ports.agentTerminals = provided.agentTerminals
  }

  offs.push(registerDocumentApi(router, {
    document,
    presence,
    checkRemoval: (removing, discard) => sessions.checkRemoval(removing, discard),
    createPanel: (type, request) => factory.createPanel(type, { ...request }),
  }))

  // ---- Capabilities -----------------------------------------------------------

  rpc.register(workspaceCapability, workspaceCapabilityImpl({ trust, info: workspaceInfo(deps.runtimeId, root) }))
  rpc.register(documentCapability, documentCapabilityImpl(document, presence))
  rpc.register(presenceCapability, presenceCapabilityImpl(presence))
  rpc.register(fileCapability, fileCapabilityImpl(files))
  rpc.register(searchCapability, searchCapabilityImpl(files))
  rpc.register(vcsCapability, vcsCapabilityImpl(repository))
  rpc.register(skillsCapability, skillsCapabilityImpl(skills))
  rpc.register(processCapability, processCapabilityImpl(terminal))
  rpc.register(browserDataCapability, browserDataCapabilityImpl(browserData))
  rpc.register(t3Capability, t3CapabilityImpl(t3))
  rpc.register(agentsCapability, agentsRuntime.capability())
  rpc.register(notificationsCapability, notificationsCapabilityImpl(notifications))
  rpc.register(sessionCapability, sessionCapabilityImpl({ host, presence }))
  rpc.register(surfaceCapability, broker.capability())
  rpc.register(apiCapability, apiCapabilityImpl(router))

  // ---- Trusted work -----------------------------------------------------------

  // Work that runs repository config or `.cate/` content: at start once
  // trusted, and again when trust is granted.
  const reconcileWorktrees = async () => {
    if (!trust.isTrusted()) return
    await repository.reconcileWorktrees()
      .catch((err: Error) => log.warn('reconciling worktrees failed: %s', err.message))
  }
  const seedSkills = async () => {
    if (!trust.isTrusted() || !settings.get('cliSkillInstallEnabled')) return
    await skills.seedBundled().catch((err: Error) => log.warn('seeding bundled skills failed: %s', err.message))
  }
  // Granting runs the trusted work; revoking ends every process the
  // workspace runs (terminals, T3 harnesses) and stops the git monitors.
  offs.push(trust.onChange((state) => {
    repository.trustChanged()
    if (state.trusted) {
      void reconcileWorktrees().then(seedSkills)
      return
    }
    for (const term of terminal.list()) if (term.alive) terminal.kill(term.id)
    void t3.stopAll().catch((err: Error) => log.warn('stopping T3 on revoke failed: %s', err.message))
  }))

  return {
    trust,
    files,
    document,
    presence,
    router,
    tokens,
    terminal,
    agents: agentsRuntime,
    notifications,
    t3,
    host,
    /** Page operations on clients' surfaces (section 10.2). */
    surfaces: broker as SurfaceBroker,
    /** For `RpcServerOptions.acceptHello`: refuses unknown caller tokens. */
    acceptHello(hello: HelloMessage): void {
      acceptCallerHello(router, hello)
    },
    /** Restores unsaved buffers, worktree checkouts (sessions in a checkout
     *  need it in the path scope) and panel sessions; seeds skills after. */
    async start(): Promise<void> {
      await files.buffers.restore()
      await reconcileWorktrees()
      await sessions.restore()
      connectedEditors.reconcile()
      void seedSkills()
    },
    /** Disposes sessions, then modules, then flushes state files. The rpc
     *  server has stopped accepting by now. */
    async shutdown(): Promise<void> {
      for (const off of offs.splice(0).reverse()) off()
      sessions.dispose()
      broker.dispose()
      connectedEditors.dispose()
      agentsRuntime.dispose()
      await t3.dispose()
      await terminal.shutdown()
      repository.dispose()
      presence.dispose()
      await skills.dispose()
      await files.dispose()
      browserData.dispose()
      document.dispose()
      await trust.flush()
      trust.dispose()
    },
  }
}

// ---- Adapters ----------------------------------------------------------------

function apiPanel(record: PanelRecord | undefined) {
  if (!record) return undefined
  const group = record.fields.placementGroupId
  return { id: record.id, type: record.type, ...(typeof group === 'string' ? { placementGroupId: group } : {}) }
}

function sharedEditor(session: unknown): SharedEditor | undefined {
  const candidate = session as Partial<SharedEditor> | undefined
  return candidate && typeof candidate.setShared === 'function' && typeof candidate.flushShared === 'function'
    ? candidate as SharedEditor
    : undefined
}

/** The document as the agents service reads and writes it. The relation
 *  context mode and the user's own title live in record fields. */
function agentsDocument(document: ReturnType<typeof createDocumentService>): AgentsDocument {
  const update = (panelId: string, patch: { title?: string; fields?: Record<string, string> }) => {
    try {
      document.apply({ kind: 'updatePanel', id: panelId, patch })
    } catch { /* the panel is gone */ }
  }
  return {
    panel: (panelId) => document.get().panels[panelId],
    panels: () => Object.values(document.get().panels),
    relations: () => Object.values(document.get().relations),
    worktreePath: (worktreeId) => document.get().worktrees[worktreeId]?.path,
    setRelationContextMode: (panelId, mode) => update(panelId, { fields: { [RELATION_CONTEXT_MODE_FIELD]: mode } }),
    setTitleFromAgent(panelId, title) {
      const record = document.get().panels[panelId]
      if (!record || record.fields.titleUserOverridden === true || record.title === title) return
      update(panelId, { title })
    },
    onChange: (listener) => document.subscribe(() => listener()),
  }
}

/** Agent terminals from the terminal type's port; without one, starting an
 *  agent in a terminal fails with `unsupported`. */
function lateAgentTerminals(port: () => AgentStartPorts['terminals'] | undefined): AgentStartPorts['terminals'] {
  const get = (): AgentStartPorts['terminals'] => {
    const terminals = port()
    if (!terminals) throw new RpcError('unsupported', 'this runtime has no terminal panels')
    return terminals
  }
  return {
    create: (params) => get().create(params),
    relaunch: (panelId, params) => get().relaunch(panelId, params),
    state: (panelId) => port()?.state(panelId) ?? null,
  }
}
