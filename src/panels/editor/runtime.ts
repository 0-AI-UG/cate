// What the daemon's composition root needs for the editor: the registry
// entry (definition plus a session class bound to its deps) and the
// `cate.editor.*` service handlers.

import path from 'node:path'
import type { CateServiceHandlers } from '@kernel/api/contract'
import type { ApiRouter } from '@kernel/api/runtime'
import { RpcError } from '@kernel/rpc/contract'
import type { PanelSessionClass, SessionKit } from '@panels/framework/runtime'
import type { PanelId, PanelRecord, WorkspaceDocument } from '@workspace/document/contract'
import { pathKey } from '@workspace/files/contract'
import { editorApi } from './contract'
import { editorDefinition } from './definition'
import { EditorSession, filePathOf, type EditorSessionDeps } from './session'

export { editorDefinition } from './definition'
export { EditorSession, movedPath, type EditorSessionDeps } from './session'

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function editorPanel(deps: EditorSessionDeps): { definition: typeof editorDefinition; session: PanelSessionClass } {
  class BoundEditorSession extends EditorSession {
    constructor(kit: SessionKit, record: PanelRecord) {
      super(kit, record, deps)
    }
  }
  return { definition: editorDefinition, session: BoundEditorSession as unknown as PanelSessionClass }
}

export interface EditorApiDeps {
  root: string
  document: { get(): WorkspaceDocument }
  /** The files path scope: `strict` rejects paths outside the workspace. */
  paths: { strict(p: string): Promise<string> }
  stat(p: string): Promise<{ isDirectory: boolean }>
  /** The panel factory's `createPanel`. */
  createPanel(type: 'editor', options: { filePath: string; near?: PanelId; placementGroupId?: string }): PanelId | null
  /** The session host: a started editor session, for the reveal. */
  started(panelId: PanelId): Promise<void>
  session(panelId: PanelId): unknown
}

export function editorServiceHandlers(deps: EditorApiDeps): CateServiceHandlers<typeof editorApi> {
  return {
    openFile: async ({ path: requested, line, column }, ctx) => {
      const file = await deps.paths.strict(path.resolve(deps.root, requested))
      let stat: { isDirectory: boolean }
      try {
        stat = await deps.stat(file)
      } catch {
        throw new RpcError('rejected', `file not found: ${requested}`)
      }
      if (stat.isDirectory) throw new RpcError('rejected', `${requested} is a directory`)
      const existing = Object.values(deps.document.get().panels)
        .find((record) => record.type === 'editor' && pathKey(filePathOf(record) ?? '') === pathKey(file))
      const panelId = existing?.id ?? deps.createPanel('editor', {
        filePath: file,
        ...(ctx.caller.panelId ? { near: ctx.caller.panelId } : {}),
        ...(ctx.caller.placementGroupId ? { placementGroupId: ctx.caller.placementGroupId } : {}),
      })
      if (!panelId) throw new RpcError('rejected', `could not open ${requested}`)
      if (line !== undefined) {
        await deps.started(panelId)
        const session = deps.session(panelId)
        if (session instanceof EditorSession) session.reveal(line, column)
      }
      return { panelId }
    },
  }
}

export function registerEditorApi(router: Pick<ApiRouter, 'registerService'>, deps: EditorApiDeps): () => void {
  return router.registerService(editorApi, editorServiceHandlers(deps))
}
