// workspace/files ui: the file explorer, the search view and their stores.

import './clientUi'

export { FileViewsContext, useFileViewsHost, type FileViewsHost } from './FileViewsContext'
export { FileExplorer, type FileExplorerProps } from './FileExplorer'
export { FileTreeNode, getFileIcon, type IconDef } from './FileTreeNode'
export { VirtualFileRows, type VirtualFileRowsHandle } from './VirtualFileRows'
export { CreateFileForm, type CreateFileFormProps } from './CreateFileForm'
export { SavePathDialog, showSavePathDialog, type SavePathRequest } from './SavePathDialog'
export { InlineEditInput, type InlineEditInputProps } from './InlineEditInput'
export { canCopyFiles, copyFileRefs, clipboardFileRefs } from './fileClipboard'
export { isNavKey, resolveTreeNavAction, type NavRow, type NavAction, type NavKey } from './treeKeyboardNav'
export {
  useTreeCollapseStore,
  useIsCollapsed,
  toggleCollapsed,
  canvasKey,
  skillsKey,
  skillAgentKey,
} from './treeCollapse'
export {
  buildGitTreeDecorations,
  gitDecorationFor,
  effectiveStatusChar,
  folderColorClass,
  lookupNodeDecoration,
  toPosixPath,
  type GitTree,
  type GitDecoration,
  type GitTreeDecorations,
  type FolderChangeKind,
  type NodeGitDecoration,
} from './gitStatusDecoration'
export { useGitTree } from './gitTree'
export {
  isExternalFileDrag,
  isAnyFileDrag,
  takeFileDrop,
  resolveFileDrop,
  type FileDrop,
  refDropMode,
  takeDroppedItems,
  readDroppedEntries,
  droppedImport,
  type DroppedItem,
  type DroppedItems,
} from './droppedEntries'
export { SearchView, type SearchViewProps } from './SearchView'
export { SearchResultsTree } from './SearchResultsTree'
export { trimLeading } from './searchDisplay'
export {
  createSearchStore,
  mergeFiles,
  lineKey,
  type SearchStore,
  type SearchState,
  type SearchStatus,
  type SearchOptionFields,
} from './searchStore'
export { SearchStoreContext, useSearchStoreContext } from './SearchStoreContext'
export {
  panelSearchStore,
  releasePanelSearchStore,
  capturePanelSearch,
  type PanelSearchSnapshot,
  type PanelSearchOptions,
} from './panelSearchStores'
