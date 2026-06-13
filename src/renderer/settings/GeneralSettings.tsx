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
        label="Privacy"
        description="Cate collects anonymous usage data and crash reports to improve the app. No file paths, project names, or personal data."
      >
        <button
          type="button"
          onClick={() => window.electronAPI?.openExternalUrl('https://cate.cero-ai.com/privacy')}
          className="text-blue-400 hover:text-blue-300 text-[12px] font-medium whitespace-nowrap"
        >
          Privacy Policy
        </button>
      </SettingRow>
    </div>
  )
}
