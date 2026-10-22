import { defineSettings, everyItem, setting } from '@kernel/settings/contract/define'

/** The longest words a relation's own label takes. */
export const RELATION_LABEL_MAX = 80

export const relationLabelSettings = defineSettings({
  scope: 'client',
  keys: {
    /** A personal library of relation labels, reused across workspaces. */
    savedPanelRelationLabels: setting<string[]>(
      [],
      everyItem((label) => typeof label === 'string' && label.trim().length > 0 && label.length <= RELATION_LABEL_MAX),
    ),
  },
})

export const relationSettings = defineSettings({
  scope: 'workspace',
  keys: {
    panelRelationsEnabled: setting(true),
  },
})
