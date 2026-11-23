import { defineSettings, setting } from '@kernel/settings/contract/define'

export const repositoryClientSettings = defineSettings({
  scope: 'client',
  keys: {
    /** Tint a panel that switches worktrees with its worktree's color. */
    worktreeTint: setting(false),
  },
})

export const repositorySettings = defineSettings({
  scope: 'workspace',
  keys: {
    /** Discarding a worktree also closes its terminal and agent panels. */
    closeWorktreePanelsOnDelete: setting(true),
  },
})
