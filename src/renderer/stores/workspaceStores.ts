// =============================================================================
// Re-export shim — the per-workspace dock-store registry moved to
// lib/workspace/dockRegistry.ts (the canonical home for a workspace's
// stores/registries). Kept here so existing importers keep working.
// =============================================================================

export {
  getOrCreateWorkspaceDockStore,
  getWorkspaceDockStore,
  releaseWorkspaceDockStore,
} from '../lib/workspace/dockRegistry'
