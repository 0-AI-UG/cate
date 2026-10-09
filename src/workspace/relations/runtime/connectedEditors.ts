// Connected editors (9.7, docs/connected-editors.md): an editor reachable
// through a terminal or chat panel's outgoing relations shares a working file
// with the agent. This service decides which editors are shared, tells their
// sessions, and flushes them before a prompt is submitted. Editor sessions
// live in a higher layer; the composition root passes the lookup.

import { RpcError } from '@kernel/rpc/contract'
import type { PanelId, PanelRecord, WorkspaceDocument } from '@workspace/document/contract'
import {
  compileRelationContext,
  isExecutionSurface,
  relationPanels,
  type RelationRoleOf,
} from '../contract'

/** What an editor session offers for sharing. */
export interface SharedEditor {
  /** Shared editors autosave (300 ms) and materialize a draft when untitled. */
  setShared(shared: boolean): void
  /** Saves pending edits; false on a conflict or a failed save. */
  flushShared(): Promise<boolean>
}

export interface ConnectedEditorsDeps {
  document: {
    get(): WorkspaceDocument
    subscribe(listener: () => void): () => void
  }
  /** The `panelRelationsEnabled` workspace setting. */
  enabled(): boolean
  onEnabledChange?(listener: () => void): () => void
  /** The editor session of a panel, when it has one. */
  editor(panelId: PanelId): SharedEditor | undefined
  /** Each panel type's relation role (its definition's `relation` hook). */
  relationRole: RelationRoleOf
}

export interface ConnectedEditors {
  /** The text editors reachable from an execution panel's relations. */
  connected(sourceId: PanelId): PanelRecord[]
  /** Tells every editor whether it is shared now. Runs on document and
   *  setting changes; exposed for tests and for late editor sessions. */
  reconcile(): void
  /** Flushes the editors connected to `sourceId` before its prompt is sent.
   *  Throws `RpcError('conflict')` naming the first editor that could not
   *  sync. */
  flush(sourceId: PanelId): Promise<void>
  dispose(): void
}

export function createConnectedEditors(deps: ConnectedEditorsDeps): ConnectedEditors {
  const connectedIn = (doc: WorkspaceDocument, sourceId: PanelId): PanelRecord[] => {
    const panels = relationPanels(Object.values(doc.panels), deps.relationRole)
    const context = compileRelationContext(sourceId, panels, Object.values(doc.relations))
    return (context?.relatedPanelIds ?? [])
      .filter((id) => panels[id]?.role.sharesFile?.(panels[id]))
      .map((id) => doc.panels[id])
  }

  let shared = new Set<PanelId>()
  let scheduled = false
  let disposed = false

  const reconcile = () => {
    scheduled = false
    if (disposed) return
    const doc = deps.document.get()
    const next = new Set<PanelId>()
    if (deps.enabled()) {
      for (const source of Object.values(doc.panels)) {
        if (!isExecutionSurface({ role: deps.relationRole(source.type) ?? {} })) continue
        for (const editor of connectedIn(doc, source.id)) next.add(editor.id)
      }
    }
    for (const id of shared) if (!next.has(id)) deps.editor(id)?.setShared(false)
    for (const id of next) deps.editor(id)?.setShared(true)
    shared = next
  }
  // Coalesce: a batch of document ops reconciles once, after the session
  // host has created the sessions of new panels.
  const schedule = () => {
    if (scheduled || disposed) return
    scheduled = true
    queueMicrotask(reconcile)
  }
  const offDocument = deps.document.subscribe(schedule)
  const offSetting = deps.onEnabledChange?.(schedule)

  return {
    connected: (sourceId) => connectedIn(deps.document.get(), sourceId),
    reconcile,
    async flush(sourceId) {
      if (!deps.enabled()) return
      for (const record of connectedIn(deps.document.get(), sourceId)) {
        const editor = deps.editor(record.id)
        if (editor && !(await editor.flushShared())) {
          throw new RpcError('conflict', `Could not sync "${record.title}". Resolve its editor conflict or save error, then send again.`, { panelId: record.id })
        }
      }
    },
    dispose() {
      disposed = true
      offDocument()
      offSetting?.()
      for (const id of shared) deps.editor(id)?.setShared(false)
      shared.clear()
    },
  }
}
