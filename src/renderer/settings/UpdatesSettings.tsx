import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'

export function UpdatesSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Receive beta builds"
        description="Get early access to less stable pre-release builds. Turning this off keeps any beta you've installed until stable catches up."
      >
        <Toggle
          checked={store.betaUpdatesEnabled}
          onChange={(v) => store.setSetting('betaUpdatesEnabled', v)}
        />
      </SettingRow>
    </div>
  )
}
