import { defineSettings, everyItem, setting } from '@kernel/settings/contract/define'

export const relationLabelSettings = defineSettings({
  scope: 'client',
  keys: {
    /** A personal library of relation labels, reused across workspaces. */
    savedPanelRelationLabels: setting<string[]>(
      [],
      everyItem((label) => typeof label === 'string' && label.trim().length > 0 && label.length <= 80),
    ),
  },
})

export const relationSettings = defineSettings({
  scope: 'workspace',
  keys: {
    panelRelationsEnabled: setting(true),
  },
})
