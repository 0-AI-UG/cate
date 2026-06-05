// =============================================================================
// worktree — spatial worktree visualization (terrace territory) + membership.
// Public surface for the canvas to consume.
// =============================================================================

export { default as WorktreeTerritoryLayer } from './WorktreeTerritoryLayer'
export { useWorktreeMembership, type WorktreeGroup, type WorktreeMembership } from './useWorktreeMembership'
export { drawTerritory, type TerritoryGroup, type TerritoryRect, type TerritoryView } from './territoryRenderer'
