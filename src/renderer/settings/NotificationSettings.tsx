import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

export function NotificationSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label={t('notifications.enable')}
        description={t('notifications.enable.desc')}
      >
        <Toggle
          checked={store.notificationsEnabled}
          onChange={(v) => store.setSetting('notificationsEnabled', v)}
        />
      </SettingRow>

      <SettingRow
        label={t('notifications.unfocused')}
        description={t('notifications.unfocused.desc')}
      >
        <Toggle
          checked={store.notifyOnlyWhenUnfocused}
          onChange={(v) => store.setSetting('notifyOnlyWhenUnfocused', v)}
        />
      </SettingRow>
    </div>
  )
}
