// Settings: the repository slice (workspace scope).

import { useSyncExternalStore } from 'react'
import type { WorkspaceSettingsMirror } from '@kernel/settings/client'
import { SettingRow, Toggle } from '@kernel/ui'

export function WorktreeSettings({ settings }: { settings: WorkspaceSettingsMirror }) {
  const closePanels = useSyncExternalStore(
    (cb) => settings.subscribe(() => cb()),
    () => settings.get('closeWorktreePanelsOnDelete'),
  )
  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Close panels when discarding a worktree"
        description="Discarding a worktree also closes its terminals, agents, files, documents, and reviews."
      >
        <Toggle
          checked={closePanels}
          onChange={(v) => { void settings.set('closeWorktreePanelsOnDelete', v).catch(() => {}) }}
        />
      </SettingRow>
    </div>
  )
}
