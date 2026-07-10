// =============================================================================
// Session persistence — public barrel.
//
// The implementation is split across sessionSerialize / sessionSave /
// sessionLoad / sessionRestore / sessionStartup / sessionAutosave. This file
// re-exports the full public surface so every importer keeps using
// './lib/workspace/session' unchanged.
//
// Importing sessionRestore here also runs its module-load side effect
// (setDeferredRestoreHandler(restoreDeferredWorkspace)), so the deferred-restore
// handler is registered whenever anything pulls this barrel during bootstrap.
// =============================================================================

export { buildWorkspaceFile, projectFilesToSnapshot } from './sessionSerialize'
export { saveSession } from './sessionSave'
export { loadSession } from './sessionLoad'
export {
  restoreSession,
  restoreWorkspaceLayout,
  replayTerminalLog,
  reloadActiveWorkspaceFromDisk,
  isWorkspaceEffectivelyEmpty,
  hydrateWorkspaceFromDiskIfEmpty,
} from './sessionRestore'
export {
  restoreMultiWorkspaceSession,
  restoreDetachedWindows,
  restoreWorkspaceDetachedWindows,
  buildDockWindowRestoreInit,
  buildRestoredCanvasState,
} from './sessionStartup'
export { setupAutoSave } from './sessionAutosave'
