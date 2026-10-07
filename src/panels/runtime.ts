// The panel types the daemon serves: the one list its composition root
// imports. Each entry adapts the daemon's services to what a panel's
// `runtime.ts` asks for; adding a type with a session is its folder plus one
// entry here.

import type { ApiRouter } from '@kernel/api/runtime'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { Logger } from '@kernel/log/contract'
import type { WorkspaceSettingsStore } from '@kernel/settings/runtime'
import type { DataPaths } from '@runtime/data/runtime'
import type { DocumentService } from '@workspace/document/runtime'
import type { FilesRuntime } from '@workspace/files/runtime'
import type { RepositoryRuntime } from '@workspace/repository/runtime'
import type { ConnectedEditors } from '@workspace/relations/runtime'
import type { TerminalService } from '@services/terminal/runtime'
import type { BrowserDataRuntime } from '@services/browser/runtime'
import type { T3Runtime } from '@services/t3/runtime'
import { activeAgentChanges, summarizeAgentChanges } from '@services/agents/contract'
import {
  evaluateAgentCliHooks,
  inspectAgentCliHooks,
  type AgentStarter,
  type AgentStartPorts,
  type AgentsRuntime,
} from '@services/agents/runtime'
import type { TerminalRunner } from '@services/agents/runners/terminal'
import type { T3Runner } from '@services/agents/runners/t3'
import type { AnyPanelDefinition } from './framework/contract'
import type { PanelFactory, PanelSessionClass, SessionHost, SurfaceBroker } from './framework/runtime'
import { createTerminalPanels } from './terminal/runtime'
import { editorPanel, registerEditorApi } from './editor/runtime'
import { reviewPanel } from './review/runtime'
import { BrowserCodeCells, browserCodeCapabilityImpl, browserPanel, browserServiceHandlers } from './browser/runtime'
import { browserApi, browserCodeCapability } from './browser/contract'
import { surfacePanel } from './surface/runtime'
import { chatPanel, type ChatBindings, type ChatChangesFeed } from './chat/runtime'
import { canvasPanel } from './canvas/runtime'

/** The runtime services the daemon hands panel types. */
export interface PanelServices {
  /** Canonical workspace root. */
  root: string
  dataPaths: DataPaths
  trust: { isTrusted(): boolean; requireTrusted(): void }
  settings: Pick<WorkspaceSettingsStore, 'get' | 'getAll' | 'subscribe'>
  log: Logger
  document: DocumentService
  files: FilesRuntime
  repository: RepositoryRuntime
  connectedEditors: ConnectedEditors
  terminal: TerminalService
  browserData: BrowserDataRuntime
  t3: T3Runtime
  agents: AgentsRuntime
  terminalRunner: TerminalRunner
  t3Runner: T3Runner
  agentStarter: AgentStarter
  /** Which thread each chat panel shows: the one instance the t3 runner
   *  also reads (`createT3Runner(agents, t3, chatBindings)`). */
  chatBindings: ChatBindings
}

export interface PanelAttachContext {
  services: PanelServices
  host: SessionHost
  factory: PanelFactory
  router: Pick<ApiRouter, 'registerService'>
  /** Page operations on the driving client. */
  surfaces: Pick<SurfaceBroker, 'request'>
  /** For a type's own capability. */
  rpc: Pick<RpcServer, 'register'>
}

/** What a panel type provides to services once the session host exists. */
export interface PanelPorts {
  /** Terminal panel: the terminals started agents run in. */
  agentTerminals?: AgentStartPorts['terminals']
}

export interface PanelModule {
  definition: AnyPanelDefinition
  /** The session class; a type without one gets a stateless session. */
  session?: PanelSessionClass
  /** Runs after the session host exists, before sessions are restored:
   *  registers `cate.<type>.*` service handlers and returns the type's ports. */
  attach?(context: PanelAttachContext): PanelPorts | void
}

export type PanelRuntime = (services: PanelServices) => PanelModule

const terminal: PanelRuntime = (services) => {
  let factory: PanelFactory | undefined
  const panels = createTerminalPanels({
    terminal: services.terminal,
    root: services.root,
    agents: {
      state: (panelId) => services.terminalRunner.state(panelId),
      send: (panelId, prompt) => services.agents.send(panelId, prompt),
      onResumeStamp: (listener) => services.terminalRunner.onResumeStamp(listener),
      resumeLaunch: (stamp) => services.terminalRunner.resumeLaunch(stamp),
    },
    open: (target, near) => target.kind === 'url'
      ? factory?.createPanel('browser', { url: target.url, near })
      : factory?.createPanel('editor', { filePath: target.path, near }),
  })
  return {
    definition: panels.definition,
    session: panels.session,
    attach: ({ host, factory: panelFactory }) => {
      factory = panelFactory
      return { agentTerminals: panels.agentTerminals(panelFactory.kit, host) }
    },
  }
}

const editor: PanelRuntime = (services) => ({
  ...editorPanel({
    root: services.root,
    buffers: services.files.buffers,
    onMoved: (listener) => services.files.onMoved(listener),
    connected: services.connectedEditors,
  }),
  attach: ({ host, factory, router }) => {
    registerEditorApi(router, {
      root: services.root,
      document: services.document,
      paths: services.files.paths,
      stat: (p) => services.files.stat(p),
      createPanel: (type, options) => factory.createPanel(type, options),
      started: (panelId) => host.started(panelId),
      session: (panelId) => host.session(panelId),
    })
  },
})

const review: PanelRuntime = (services) => {
  const { git, monitors, write } = services.repository
  const { agents } = services
  return reviewPanel({
    root: services.root,
    repository: {
      compare: (params) => git.compare(params),
      fileDiff: (params) => git.fileDiff(params),
      fileContent: (params) => git.fileContent(params),
      // Writes run in the repository's queue, like every other git write.
      stage: (params) => write(() => git.stage(params)),
      unstage: (params) => write(() => git.unstage(params)),
      discardFile: (params) => write(() => git.discardFile(params)),
      commit: (params) => write(() => git.commit(params)),
      log: (params) => git.log(params),
      branchList: (params) => git.branchList(params),
      readStatus: (params) => git.readStatus(params),
      createPr: (params) => git.createPr(params),
      watchStatus: (cwd, listener) => monitors.subscribe(cwd, listener),
      refreshStatus: (cwd) => monitors.kick(cwd),
    },
    files: {
      trash: async (p) => { await services.files.trash(p) },
      writeText: async (p, text) => { await services.files.write(p, text) },
    },
    agents: {
      readChanges: async (cwd, knownRevision) => agents.hooks.readChanges(await agents.resolveCheckout(cwd), knownRevision),
      async readiness(cwd) {
        const states = await inspectAgentCliHooks((dir) => agents.hooks.inspectWorkspace(dir), cwd)
        const config = agents.settings.agentHookInjection()
        return states.map((state) => ({ agentId: state.agent.id, ready: evaluateAgentCliHooks(state, config).ready }))
      },
      async start(ownerPanelId, { at, ...args }) {
        const { panelId } = await services.agentStarter.start(ownerPanelId, { ...args, ...(at ? { placement: { at } } : {}) })
        return { panelId }
      },
      async send(panelId, prompt) {
        const result = await agents.send(panelId, prompt)
        if (!result.ok) throw new Error(result.error)
      },
      onExit: (listener) => services.terminalRunner.onExit((panelId) => listener(panelId)),
      threadIdOf: (panelId) => services.chatBindings.binding(panelId)?.threadId,
    },
  })
}

const browser: PanelRuntime = (services) => ({
  ...browserPanel({
    browserData: services.browserData,
    settings: { get: (key) => services.settings.get(key as never) },
    files: { serveUrl: (p) => services.files.serveUrl(p) },
  }),
  attach: ({ host, router, surfaces, rpc }) => {
    const cells = new BrowserCodeCells()
    router.registerService(browserApi, browserServiceHandlers({ surfaces, sessions: host, document: services.document, cells }))
    rpc.register(browserCodeCapability, browserCodeCapabilityImpl(cells))
  },
})

const chat: PanelRuntime = (services) => {
  let factory: PanelFactory | undefined
  const { agents } = services
  return {
    ...chatPanel({
      root: services.root,
      t3: services.t3,
      bindings: services.chatBindings,
      send: (panelId, prompt) => agents.send(panelId, prompt),
      relationContext: (panelId, agentId) => agents.promptContext.prepareForSend(panelId, agentId),
      changes: chatChanges(services),
      createPanel: (type, options) => factory?.createPanel(type, options) ?? null,
    }),
    attach: ({ factory: panelFactory }) => { factory = panelFactory },
  }
}

/** A thread's recorded edits, summed per turn, counting only files still
 *  changed in the checkout: re-read whenever the checkout's status changes. */
function chatChanges(services: PanelServices): ChatChangesFeed {
  const { agents, repository } = services
  return {
    bind: async (checkout, threadId, panelId) => agents.hooks.bindChanges(await agents.resolveCheckout(checkout), threadId, panelId),
    watch(checkout, threadId, listener) {
      let stopped = false
      let revision: string | undefined
      let records: Parameters<typeof activeAgentChanges>[0] = []
      let pending = Promise.resolve()
      const stop = repository.monitors.subscribe(checkout, (status) => {
        pending = pending.then(async () => {
          try {
            const snapshot = await agents.hooks.readChanges(await agents.resolveCheckout(checkout), revision)
            if (snapshot.records) records = snapshot.records
            revision = snapshot.revision
          } catch {
            return
          }
          if (stopped) return
          const mine = activeAgentChanges(records, { isRepo: status.isRepo, statusFiles: status.files })
            .filter((record) => record.source === 't3' && record.sourceId === threadId)
          const turns = [...new Set(mine.map((record) => record.turnId))]
          listener(Object.fromEntries(turns.map((turnId) => [turnId, summarizeAgentChanges(mine.filter((record) => record.turnId === turnId))])))
        })
      })
      return () => {
        stopped = true
        stop()
      }
    },
  }
}

const canvas: PanelRuntime = () => canvasPanel()

const surface: PanelRuntime = () => surfacePanel()

export const PANEL_RUNTIMES: readonly PanelRuntime[] = [terminal, editor, review, browser, chat, canvas, surface]
