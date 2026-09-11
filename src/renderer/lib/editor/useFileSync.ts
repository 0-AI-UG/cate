import { useEffect, useSyncExternalStore } from 'react'
import type * as monaco from 'monaco-editor'
import { editorDocument, type EditorConflict } from './editorDocuments'
export type { EditorConflict }

export interface UseFileSyncParams {
  workspaceId: string
  panelId: string
  filePath: string | null | undefined
  rootPath: string | undefined
  getModel: () => monaco.editor.ITextModel | null
  onExternalReplace?: (content: string) => void
}

/** A mounted view of a document; its buffer/save lifetime belongs to the panel. */
export function useFileSync({ workspaceId, panelId, filePath, rootPath, getModel, onExternalReplace }: UseFileSyncParams) {
  const document = editorDocument(workspaceId, panelId, filePath, rootPath)
  const state = useSyncExternalStore(document.subscribe, document.getSnapshot, document.getSnapshot)
  useEffect(() => document.attach({ getModel, onReplace: onExternalReplace }), [document, getModel, onExternalReplace])
  return {
    ...state,
    filePathRef: document.filePathRef,
    isDirtyRef: document.isDirtyRef,
    noteLoaded: document.noteLoaded,
    noteUserEdit: document.noteUserEdit,
    isExternalReplace: document.isExternalReplace,
    save: document.save,
    resyncFromDisk: document.resyncFromDisk,
    discard: document.discard,
    reload: document.reload,
    keepMine: document.keepMine,
    keepBoth: document.keepBoth,
    saveToRestore: document.saveToRestore,
    dismiss: document.dismiss,
    openDiff: document.openDiff,
    closeDiff: document.closeDiff,
  }
}
export type FileSync = ReturnType<typeof useFileSync>
