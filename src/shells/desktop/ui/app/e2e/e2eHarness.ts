// The e2e harness: a small inspect/seed API on `window.__cateE2E`, installed
// by the shell when it runs under Playwright. Driving the UI for setup is
// brittle; reaching into the client stores is reliable. Hook names follow the
// ones the e2e specs use. Modules add their own hooks through `extensions`
// (the canvas view's pan, zoom and node moves, a panel type's driver).

import { clientIdentity } from '@client/connections'
import { documentStoreFor } from '@client/document'
import { createPanel, newId, panelDefinition } from '@client/host'
import { applyTheme } from '../../kernel/interaction'
import { BUILT_IN_THEMES } from '@kernel/interaction/contract'
import { documentOrder, type DocChange, type PanelRecord, type WorkspaceDocument } from '@workspace/document/contract'
import type { Point } from '@workspace/canvas/contract'
import { clientApp } from '../app'
import { openLocalFolder, selectWorkspace } from '../navigation'
import { joinWorkspace } from '@client/workspaces'
import { useUIStore } from '../state/uiStore'

/** The canvas view's hooks (ui/client/layout/canvas `createCanvasE2E`). */
export interface CanvasE2EHooks {
  activeCanvas(): { workspaceId: string; canvasId: string; canvasPanelId: string } | null
  nodes(): { id: string; panelId: string; origin: Point; size: { width: number; height: number } }[]
  nodeForPanel(panelId: string): string | null
  zoom(): number
  setZoom(zoom: number): void
  resetViewport(): void
  setViewportOffset(offset: Point): void
  moveNode(nodeId: string, origin: Point): void
  seedWorktrees(specs: { color: string; label?: string }[], rootPath?: string): { id: string; path: string; color: string }[]
  tagNodeWorktree(nodeId: string, worktreeId: string): boolean
  worktreeDebug(): { liveWorktrees: number; metaWorktrees: number; taggedNodes: number; distinctGroups: number; glActive: boolean }
}

export interface ClientE2E {
  ready: true
  selectedWorkspaceId(): string | null
  selectWorkspace(id: string): Promise<void>
  /** Adds a local folder and opens it; returns the workspace id. */
  addWorkspace(name?: string, rootPath?: string): Promise<string>
  panels(): PanelRecord[]
  panelTypes(workspaceId?: string): string[]
  /** `options` go to client/host `createPanel` (`at`, `near`, `position`, fields). */
  createPanel(type: string, options?: Record<string, unknown>): string | null
  /** Creates a panel as a new node on the active canvas at exactly `origin`. */
  createOnCanvas(type: string, origin?: Point, options?: Record<string, unknown>): { panelId: string; nodeId: string } | null
  document(workspaceId?: string): WorkspaceDocument | null
  /** Proposes one document change through the client's mirror. */
  propose(change: DocChange, workspaceId?: string): { ok: boolean }
  /** One runtime capability method over the workspace's connection. */
  call(cap: string, method: string, params?: unknown, workspaceId?: string): Promise<unknown>
  /** The panel's session snapshot, once one arrived (null after `timeoutMs`). */
  sessionSnapshot(panelId: string, workspaceId?: string, timeoutMs?: number): Promise<unknown>
  sessionOp(panelId: string, op: unknown, workspaceId?: string): Promise<unknown>
  /** The connected clients as the runtime reports them. */
  presence(workspaceId?: string): Promise<unknown>
  connection(workspaceId?: string): { kind: string; state: string } | null
  /** The terminal panel's screen as the runtime keeps it. */
  terminalText(panelId: string, workspaceId?: string): Promise<string>
  writeTerminal(panelId: string, data: string, workspaceId?: string): Promise<void>
  /** Pairs with the runtime behind a pairing link or code and opens it. */
  joinWorkspace(input: string): Promise<string>
  workspaceIds(): string[]
  /** This client's id, as presence lists it. */
  clientId(): string
  openSettings(section?: string): void
  openApplicationOverlay(view: string, section?: string): void
  setSidebarHidden(hidden: boolean): void
  openCommandPalette(): void
  setTheme(themeId: string): void
  activeCanvasPanelId(): string | null
  setViewport(offset: Point): void
  [hook: string]: unknown
}

declare global {
  interface Window {
    __cateE2E?: ClientE2E
  }
}

const selected = (): string | null => useUIStore.getState().selectedWorkspaceId

function panelsOf(workspaceId: string | null): PanelRecord[] {
  const doc = workspaceId ? documentStoreFor(workspaceId)?.getSnapshot() : null
  if (!doc) return []
  return documentOrder(doc).map((id) => doc.panels[id]).filter((p): p is PanelRecord => !!p)
}

const connectionOf = (workspaceId?: string) => {
  const id = workspaceId ?? selected()
  const connection = id ? clientApp().connections.get(id) : undefined
  if (!connection) throw new Error(`no connection for ${id ?? 'the selected workspace'}`)
  return connection
}

async function sessionSnapshotOf(panelId: string, workspaceId?: string, timeoutMs = 10_000): Promise<unknown> {
  const handle = connectionOf(workspaceId).subscribeSession(panelId)
  try {
    const deadline = Date.now() + timeoutMs
    while (!handle.getSnapshot() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    return handle.getSnapshot()?.snapshot ?? null
  } finally {
    handle.release()
  }
}

async function ptyOf(panelId: string, workspaceId?: string): Promise<string> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const snapshot = await sessionSnapshotOf(panelId, workspaceId) as { ptyId?: string | null } | null
    if (snapshot?.ptyId) return snapshot.ptyId
    if (Date.now() > deadline) throw new Error(`terminal ${panelId} has no pty`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function createClientE2E(options: { canvas?: CanvasE2EHooks; extensions?: Record<string, unknown> } = {}): ClientE2E {
  const canvas = options.canvas
  return {
    ...(canvas ?? {}),
    ...(options.extensions ?? {}),
    ready: true,
    selectedWorkspaceId: selected,
    async selectWorkspace(id) { await selectWorkspace(id) },
    async addWorkspace(name, rootPath) {
      if (!rootPath) throw new Error('addWorkspace needs a folder')
      const entry = await clientApp().workspaces.addLocal(rootPath, name)
      await openLocalFolder(rootPath)
      return entry.id
    },
    panels: () => panelsOf(selected()),
    panelTypes: (workspaceId) => [...new Set(panelsOf(workspaceId ?? selected()).map((p) => p.type))],
    createPanel(type, options) {
      const workspaceId = selected()
      return workspaceId ? createPanel(workspaceId, type, options ?? {}) : null
    },
    createOnCanvas(type, origin = { x: 100, y: 100 }, options = {}) {
      const active = canvas?.activeCanvas()
      const definition = panelDefinition(type)
      if (!active || !definition) return null
      const nodeId = newId()
      const size = definition.defaultSize
      const at = { to: 'canvas' as const, canvasId: active.canvasId, nodeId, stackId: newId(), rect: { origin, size } }
      const panelId = createPanel(active.workspaceId, type, { ...options, at })
      return panelId ? { panelId, nodeId } : null
    },
    document: (workspaceId) => {
      const id = workspaceId ?? selected()
      return (id && documentStoreFor(id)?.getSnapshot()) || null
    },
    propose(change, workspaceId) {
      const id = workspaceId ?? selected()
      const store = id ? documentStoreFor(id) : null
      return { ok: !!store && store.propose(change).ok }
    },
    async call(cap, method, params, workspaceId) {
      const proxy = (connectionOf(workspaceId).runtime as unknown as Record<string, Record<string, (p: unknown) => Promise<unknown>>>)[cap]
      const fn = proxy?.[method]
      if (!fn) throw new Error(`unknown ${cap}.${method}`)
      return fn(params)
    },
    sessionSnapshot: sessionSnapshotOf,
    async sessionOp(panelId, op, workspaceId) {
      const handle = connectionOf(workspaceId).subscribeSession(panelId)
      try { return await handle.send(op) } finally { handle.release() }
    },
    presence(workspaceId) {
      const sub = connectionOf(workspaceId).runtime.presence.subscribe()
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { sub.cancel(); reject(new Error('no presence event')) }, 10_000)
        sub.onEvent((event) => { clearTimeout(timer); sub.cancel(); resolve(event) })
      })
    },
    connection(workspaceId) {
      const id = workspaceId ?? selected()
      const connection = id ? clientApp().connections.get(id) : undefined
      return connection ? { kind: connection.kind, state: connection.state.kind } : null
    },
    async terminalText(panelId, workspaceId) {
      const id = await ptyOf(panelId, workspaceId)
      return (await connectionOf(workspaceId).runtime.process.read({ id })).text
    },
    async writeTerminal(panelId, data, workspaceId) {
      const id = await ptyOf(panelId, workspaceId)
      // As a view types: through an attach of its own, as a hidden viewer.
      const attach = connectionOf(workspaceId).runtime.process.attach({ id, visible: false })
      await new Promise<void>((resolve) => {
        const off = attach.onEvent((event) => {
          if (event.kind !== 'screen') return
          off()
          attach.write(new TextEncoder().encode(data))
          resolve()
        })
      })
      setTimeout(() => attach.cancel(), 100)
    },
    async joinWorkspace(input) {
      const app = clientApp()
      if (!app.pair) throw new Error('this shell cannot pair')
      const entry = await joinWorkspace(input, { pair: app.pair, workspaces: app.workspaces })
      await selectWorkspace(entry.id)
      return entry.id
    },
    clientId: () => clientIdentity().clientId,
    workspaceIds: () => clientApp().workspaces.getSnapshot().entries.map((e) => e.id),
    openSettings: (section) => useUIStore.getState().openSettings(section),
    openApplicationOverlay: (view, section) => useUIStore.getState().openOverlay({ view, ...(section ? { section } : {}) }),
    setSidebarHidden: (hidden) => useUIStore.getState().setSidebarHidden(hidden),
    openCommandPalette: () => useUIStore.getState().setCommandPaletteOpen(true),
    setTheme(themeId) {
      if (themeId === 'system' || BUILT_IN_THEMES.some((t) => t.id === themeId)) applyTheme(themeId)
    },
    activeCanvasPanelId: () => canvas?.activeCanvas()?.canvasPanelId ?? null,
    setViewport: (offset) => canvas?.setViewportOffset(offset),
  }
}

/** Mounts the harness on `window.__cateE2E`. Returns a remover. */
export function installE2eHarness(options: { canvas?: CanvasE2EHooks; extensions?: Record<string, unknown> } = {}): () => void {
  window.__cateE2E = createClientE2E(options)
  return () => { delete window.__cateE2E }
}
