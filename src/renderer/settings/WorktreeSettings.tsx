import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'

export function WorktreeSettings() {
  const store = useSettingsStore()
  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Close panels when discarding a worktree"
        description="Discarding a worktree also closes its terminals, agents, files, documents, and reviews."
      >
        <Toggle
          checked={store.closeWorktreePanelsOnDelete}
          onChange={(v) => store.setSetting('closeWorktreePanelsOnDelete', v)}
        />
      </SettingRow>
    </div>
  )
}
