// `cate.panel.*` and `cate.canvas.*` (architecture 14): panels as document
// records. Creating a panel and asking sessions before a close belong to the
// panel framework, a higher layer, so the composition root passes them in.

import type { Point } from '@workspace/canvas/contract'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { ApiRouter } from '@kernel/api/runtime'
import { RpcError } from '@kernel/rpc/contract'
import { removalSet, type PanelId, type PanelRecord } from '../contract'
import { canvasApi, panelApi } from '../contract/api'
import type { DocumentService } from './documentService'
import type { PresenceService } from './presence'

/** A `cate.canvas.createPanel` call as the panel framework receives it. */
export type CreatePanelRequest = {
  /** The calling panel: the new one is placed next to it. */
  near?: PanelId
  position?: Point
  url?: string
  filePath?: string
  placementGroupId?: string
}

export interface DocumentApiDeps {
  document: DocumentService
  presence: Pick<PresenceService, 'activePanelId'>
  /** Throws `RpcError('dirty')` when removing `removing` loses work outside
   *  `discard` (the sessions' close blockers). */
  checkRemoval(removing: ReadonlySet<PanelId>, discard: ReadonlySet<PanelId>): void
  /** Returns the new panel's id, or null when it could not be created. */
  createPanel(type: string, request: CreatePanelRequest): PanelId | null | Promise<PanelId | null>
  /** Extra columns of `cate panel list` for one record. */
  listInfo?(record: PanelRecord): { filePath?: string; url?: string } | undefined
}

export interface PanelListRow {
  panelId: PanelId
  type: string
  title: string
  focused: boolean
  filePath?: string
  url?: string
}

/** Default list columns: the record's own `filePath` and `url` fields. */
function fieldInfo(record: PanelRecord): { filePath?: string; url?: string } {
  const { filePath, url } = record.fields
  return {
    ...(typeof filePath === 'string' ? { filePath } : {}),
    ...(typeof url === 'string' ? { url } : {}),
  }
}

export function createDocumentApiHandlers(deps: DocumentApiDeps): {
  panel: CateServiceHandlers<typeof panelApi>
  canvas: CateServiceHandlers<typeof canvasApi>
} {
  const { document } = deps
  const info = deps.listInfo ?? fieldInfo

  return {
    panel: {
      list: (): PanelListRow[] => {
        const active = deps.presence.activePanelId()
        return Object.values(document.get().panels).map((record) => ({
          panelId: record.id,
          type: record.type,
          title: record.title,
          focused: record.id === active,
          ...info(record),
        }))
      },
      close: async ({ panelId, discard }) => {
        if (!document.get().panels[panelId]) throw new RpcError('gone', `panel ${panelId} is gone`)
        const removing = removalSet(document.get(), [panelId])
        const ids = [...removing]
        deps.checkRemoval(removing, new Set(discard === true ? ids : []))
        document.apply({ kind: 'removePanels', ids: [panelId], ...(discard === true ? { discard: ids } : {}) })
        return { panelIds: ids }
      },
      setTitle: ({ title, panelId }, ctx) => {
        const target = panelId ?? ctx.caller.panelId
        if (!target) throw new RpcError('rejected', 'no panel: pass --panel <id>')
        document.apply({ kind: 'updatePanel', id: target, patch: { title } })
        return { panelId: target, title }
      },
      'target.set': ({ panelId }, ctx) => {
        ctx.sticky.set(panelId)
        return { panelId }
      },
      'target.current': (_args, ctx) => {
        const panelId = ctx.sticky.get()
        if (panelId && !document.get().panels[panelId]) {
          ctx.sticky.clear()
          return { panelId: null }
        }
        return { panelId: panelId ?? null }
      },
      'target.clear': (_args, ctx) => {
        ctx.sticky.clear()
        return null
      },
    },
    canvas: {
      createPanel: async ({ type, url, filePath, position }, ctx) => {
        const panelId = await deps.createPanel(type, {
          ...(ctx.caller.panelId ? { near: ctx.caller.panelId } : {}),
          ...(ctx.caller.placementGroupId ? { placementGroupId: ctx.caller.placementGroupId } : {}),
          ...(position ? { position } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(filePath !== undefined ? { filePath } : {}),
        })
        if (!panelId) throw new RpcError('rejected', `could not create a ${type} panel`)
        return { panelId }
      },
    },
  }
}

export function registerDocumentApi(router: Pick<ApiRouter, 'registerService'>, deps: DocumentApiDeps): () => void {
  const handlers = createDocumentApiHandlers(deps)
  const offPanel = router.registerService(panelApi, handlers.panel)
  const offCanvas = router.registerService(canvasApi, handlers.canvas)
  return () => { offPanel(); offCanvas() }
}
