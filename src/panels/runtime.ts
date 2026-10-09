// The panel types the daemon serves: the one list its composition root
// imports. Each entry adapts the daemon's services to what a panel's
// `runtime.ts` asks for; adding a type with a session is its folder plus one
// entry here.

import type { ApiRouter } from '@kernel/api/runtime'
import type { RpcServer } from '@kernel/rpc/runtime'
import type { WorkspaceSettingsStore } from '@kernel/settings/runtime'
import type { DocumentService } from '@workspace/document/runtime'
import type { FilesRuntime } from '@workspace/files/runtime'
import type { RepositoryRuntime } from '@workspace/repository/runtime'
import type { ConnectedEditors } from '@workspace/relations/runtime'
import type { TerminalService } from '@services/terminal/runtime'
import type { BrowserDataRuntime } from '@services/browser/runtime'
import type { T3Runtime } from '@services/t3/runtime'
import type { AgentStartPorts, AgentsRuntime } from '@services/agents/runtime'
import type { AnyPanelDefinition } from './framework/contract'
import type { PanelFactory, PanelSessionClass, SessionHost, SurfaceBroker } from './framework/runtime'
import { createTerminalPanels } from './terminal/runtime'
import { editorPanel, registerEditorApi } from './editor/runtime'
import { reviewPanel } from './review/runtime'
import { BrowserCodeCells, browserCodeCapabilityImpl, browserPanel, browserServiceHandlers } from './browser/runtime'
import { browserApi, browserCodeCapability } from './browser/contract'
import { surfacePanel } from './surface/runtime'
import { chatPanel } from './chat/runtime'
import { canvasPanel } from './canvas/runtime'

/** The runtime services the daemon has for panel types; each type's entry
 *  below names the ones it takes (`PanelRuntime<keys>`). */
export interface PanelServices {
  /** Canonical workspace root. */
  root: string
  settings: Pick<WorkspaceSettingsStore, 'get'>
  document: DocumentService
  files: FilesRuntime
  repository: RepositoryRuntime
  connectedEditors: ConnectedEditors
  terminal: TerminalService
  browserData: BrowserDataRuntime
  t3: T3Runtime
  agents: AgentsRuntime
}

export interface PanelAttachContext {
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

/** A panel type's runtime entry over exactly the services it uses. */
export type PanelRuntime<K extends keyof PanelServices = never> = (services: Pick<PanelServices, K>) => PanelModule

const terminal: PanelRuntime<'root' | 'terminal'> = (services) => {
  let factory: PanelFactory | undefined
  const panels = createTerminalPanels({
    terminal: services.terminal,
    root: services.root,
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

const editor: PanelRuntime<'root' | 'files' | 'connectedEditors' | 'document'> = (services) => ({
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

const review: PanelRuntime<'root' | 'repository' | 'files' | 'agents'> = (services) => {
  const { git, monitors } = services.repository
  const { agents } = services
  return reviewPanel({
    root: services.root,
    // The repository's git checks trust and queues its writes.
    repository: {
      ...git,
      watchStatus: (cwd, listener) => monitors.subscribe(cwd, listener),
      refreshStatus: (cwd) => monitors.kick(cwd),
    },
    files: {
      trash: async (p) => { await services.files.trash(p) },
      writeText: async (p, text) => { await services.files.write(p, text) },
    },
    agents: {
      readChanges: (cwd, knownRevision) => agents.changes(cwd, knownRevision),
      readiness: (cwd) => agents.readiness(cwd),
      async start(ownerPanelId, { at, ...args }) {
        const { panelId } = await agents.start(ownerPanelId, { ...args, ...(at ? { placement: { at } } : {}) })
        return { panelId }
      },
      async send(panelId, prompt) {
        const result = await agents.send(panelId, prompt)
        if (!result.ok) throw new Error(result.error)
      },
      onExit: (listener) => agents.onSessionEnded(listener),
    },
  })
}

const browser: PanelRuntime<'browserData' | 'settings' | 'files' | 'document'> = (services) => ({
  ...browserPanel({
    browserData: services.browserData,
    settings: { get: (key) => services.settings.get(key as never) },
    files: { serveUrl: (p) => services.files.serveUrl(p), servedPath: (url) => services.files.servedPath(url) },
  }),
  attach: ({ host, router, surfaces, rpc }) => {
    const cells = new BrowserCodeCells()
    router.registerService(browserApi, browserServiceHandlers({ surfaces, sessions: host, document: services.document, cells }))
    rpc.register(browserCodeCapability, browserCodeCapabilityImpl(cells))
  },
})

const chat: PanelRuntime<'root' | 't3' | 'agents'> = (services) => {
  let factory: PanelFactory | undefined
  const { agents } = services
  return {
    ...chatPanel({
      root: services.root,
      t3: services.t3,
      relationContext: (panelId, agentId) => agents.relationContext(panelId, agentId),
      changes: { watch: (panelId, listener) => agents.watchChanges(panelId, listener) },
      createPanel: (type, options) => factory?.createPanel(type, options) ?? null,
    }),
    attach: ({ factory: panelFactory }) => { factory = panelFactory },
  }
}

const canvas: PanelRuntime = () => canvasPanel()

const surface: PanelRuntime = () => surfacePanel()

export const PANEL_RUNTIMES: readonly PanelRuntime<keyof PanelServices>[] = [terminal, editor, review, browser, chat, canvas, surface]
