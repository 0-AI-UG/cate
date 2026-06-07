import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

export function UpdatesSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label={t('updates.beta')}
        description={t('updates.beta.desc')}
      >
        <Toggle
          checked={store.betaUpdatesEnabled}
          onChange={(v) => store.setSetting('betaUpdatesEnabled', v)}
        />
      </SettingRow>
    </div>
  )
}
