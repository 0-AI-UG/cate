import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'

export function UpdatesSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Receive beta builds"
        description="Get early access to staged, pre-release versions. Betas may be less stable. They never affect the public download, and turning this off won't downgrade a beta you've already installed — you'll move to stable once it catches up."
      >
        <Toggle
          checked={store.betaUpdatesEnabled}
          onChange={(v) => store.setSetting('betaUpdatesEnabled', v)}
        />
      </SettingRow>
    </div>
  )
}
