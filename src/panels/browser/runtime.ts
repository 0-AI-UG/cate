// What the daemon's composition root needs for the browser panel: its
// definition and session class, the `cate.browser.*` service handlers (`run`,
// `reset`, `listTabs`) and the `browserCode` capability.

import { RpcError, isRpcError } from '@kernel/rpc/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { BrowserCodeResult } from '@services/browser/contract'
import type { PanelId, WorkspaceDocument } from '@workspace/document/contract'
import type { PanelSession, SurfaceBroker, SurfaceCallOptions } from '@panels/framework/runtime'
import { BROWSER_CODE_TIMEOUT_MS, BROWSER_SURFACE_FEATURES, type BrowserSnapshot, type BrowserSurfaceArgs, type BrowserSurfaceOp, type browserApi } from './contract'
import definition from './definition'
import { BrowserCodeCells, browserCodeCapabilityImpl } from './parts/runtime/codeCells'
import { BrowserSession, createBrowserSessionClass, type BrowserSessionDeps } from './session'

export { definition as browserDefinition, BrowserSession, createBrowserSessionClass, type BrowserSessionDeps }
export { BrowserCodeCells, browserCodeCapabilityImpl }

/** A cell's own deadline; the router's is `BROWSER_CODE_TIMEOUT_MS`, a little longer. */
export const BROWSER_CELL_DEADLINE_MS = 30_000

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function browserPanel(deps: BrowserSessionDeps) {
  return { definition, session: createBrowserSessionClass(deps) }
}

export interface BrowserServiceDeps {
  /** The surface broker: page operations on the driving client. */
  surfaces: Pick<SurfaceBroker, 'request'>
  sessions: { session(panelId: PanelId): PanelSession | undefined }
  document: { get(): WorkspaceDocument }
  cells: BrowserCodeCells
  newId?: () => string
  now?: () => number
}

const text = (message: string): BrowserCodeResult => ({ content: [{ type: 'text', text: message }], isError: true })

/** The service half of `cate.browser.*`. A cell runs on the driving client of
 *  its default panel (or of any browser, with none); its `cua.*` calls come
 *  back through `browserCode.call` as the same caller. */
export function browserServiceHandlers(deps: BrowserServiceDeps): CateServiceHandlers<typeof browserApi> {
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const now = deps.now ?? Date.now
  const request = <Op extends BrowserSurfaceOp>(panelId: string | null, op: Op, args: BrowserSurfaceArgs<Op>, options?: SurfaceCallOptions) =>
    deps.surfaces.request(panelId, op, args, { ...options, feature: BROWSER_SURFACE_FEATURES[op] })

  const browserPanels = (): PanelId[] =>
    Object.values(deps.document.get().panels).filter((record) => record.type === 'browser').map((record) => record.id)

  return {
    run: async ({ code, panelId }, ctx) => {
      // Any client with a page driver can run the cell (the cell binds tabs
      // itself); the caller's browser panel's driver is preferred.
      const target = panelId ?? ctx.defaultTarget('browser') ?? null
      const cellId = newId()
      deps.cells.begin(cellId, { deadline: now() + BROWSER_CELL_DEADLINE_MS, invoke: ctx.invoke })
      try {
        return await request(target, 'code.run', { key: ctx.caller.id, cellId, code, deadlineMs: BROWSER_CELL_DEADLINE_MS }, {
          timeoutMs: BROWSER_CODE_TIMEOUT_MS - 2_000,
          signal: ctx.signal,
        })
      } catch (err) {
        if (isRpcError(err, 'timeout')) void request(target, 'code.reset', { key: ctx.caller.id }).catch(() => {})
        if (isRpcError(err, 'no-renderer')) return text('No connected client can run browser code')
        return text(err instanceof Error ? err.message : String(err))
      } finally {
        deps.cells.end(cellId)
      }
    },
    reset: async (_args, ctx) => {
      const target = ctx.defaultTarget('browser') ?? null
      try {
        await request(target, 'code.reset', { key: ctx.caller.id })
      } catch (err) {
        if (!isRpcError(err, 'no-renderer')) throw err
      }
      return { content: [{ type: 'text', text: 'Browser code session reset' }] } satisfies BrowserCodeResult
    },
    listTabs: ({ panelId }) => {
      const ids = panelId ? [panelId] : browserPanels()
      const tabs = ids.flatMap((id) => {
        const session = deps.sessions.session(id)
        if (!session) return []
        const snapshot = session.snapshot() as BrowserSnapshot
        return snapshot.tabs.map(({ nav: _nav, navSource: _source, ...tab }) => ({
          ...tab,
          panelId: id,
          tabId: tab.id,
          active: tab.id === snapshot.activeTabId,
        }))
      })
      if (panelId && !deps.sessions.session(panelId)) throw new RpcError('gone', `panel ${panelId} is gone`)
      return { tabs }
    },
  }
}
