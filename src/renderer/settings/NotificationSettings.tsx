import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'

export function NotificationSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Sound notifications" description="Play sounds for command completion and Claude input requests">
        <Toggle checked={store.soundNotificationsEnabled} onChange={(v) => store.setSetting('soundNotificationsEnabled', v)} />
      </SettingRow>
      <SettingRow label="Visual notifications" description="Show colored borders on panels for activity">
        <Toggle checked={store.visualNotificationsEnabled} onChange={(v) => store.setSetting('visualNotificationsEnabled', v)} />
      </SettingRow>
    </div>
  )
}
