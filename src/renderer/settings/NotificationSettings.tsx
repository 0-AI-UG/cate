import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'

export function NotificationSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Enable notifications"
        description="Show an OS notification when an agent finishes or needs input"
      >
        <Toggle
          checked={store.notificationsEnabled}
          onChange={(v) => store.setSetting('notificationsEnabled', v)}
        />
      </SettingRow>

      <SettingRow
        label="Only when window unfocused"
        description="Skip notifications while Cate is in focus"
      >
        <Toggle
          checked={store.notifyOnlyWhenUnfocused}
          onChange={(v) => store.setSetting('notifyOnlyWhenUnfocused', v)}
        />
      </SettingRow>
    </div>
  )
}
