import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, TextInput, Select } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

export function GeneralSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label={t('general.language')} description={t('general.language.desc')}>
        <Select
          value={store.language ?? 'en'}
          onChange={(v) => store.setSetting('language', v as 'en' | 'ko')}
          options={[
            { value: 'en', label: 'English' },
            { value: 'ko', label: '한국어' },
          ]}
        />
      </SettingRow>
      <SettingRow label={t('general.shell')} description={t('general.shell.desc')}>
        <TextInput value={store.defaultShellPath} onChange={(v) => store.setSetting('defaultShellPath', v)} placeholder="Auto-detect" />
      </SettingRow>
      <SettingRow label={t('general.warnQuit')} description={t('general.warnQuit.desc')}>
        <Toggle checked={store.warnBeforeQuit} onChange={(v) => store.setSetting('warnBeforeQuit', v)} />
      </SettingRow>
      <SettingRow
        label="Send crash reports"
        description="Anonymously report unhandled errors to help us fix bugs."
      >
        <Toggle checked={store.crashReportingEnabled} onChange={(v) => store.setSetting('crashReportingEnabled', v)} />
      </SettingRow>
      <SettingRow
        label="Send anonymous usage data"
        description="App version, OS, and update events only. No file paths, project names, or personal data."
      >
        <Toggle checked={store.usageAnalyticsEnabled} onChange={(v) => store.setSetting('usageAnalyticsEnabled', v)} />
      </SettingRow>
    </div>
  )
}
