import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, TextInput } from './SettingsComponents'

export function GeneralSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Default shell path" description="Leave blank to auto-detect ($SHELL, then a platform default).">
        <TextInput value={store.defaultShellPath} onChange={(v) => store.setSetting('defaultShellPath', v)} placeholder="Auto-detect" />
      </SettingRow>
      <SettingRow label="Warn before quit" description="Show confirmation dialog on Cmd+Q">
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
        description="App version, OS, and update events — no file paths, project names, or personal data. Helps us see which versions are in use and prompt for feedback after upgrades."
      >
        <Toggle checked={store.usageAnalyticsEnabled} onChange={(v) => store.setSetting('usageAnalyticsEnabled', v)} />
      </SettingRow>
    </div>
  )
}
