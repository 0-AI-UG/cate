import { defineSettings, setting } from '@kernel/settings/contract/define'

export const repositorySettings = defineSettings({
  scope: 'workspace',
  keys: {
    /** Discarding a worktree also closes its terminal and agent panels. */
    closeWorktreePanelsOnDelete: setting(true),
  },
})
