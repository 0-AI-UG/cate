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
      {navigator.userAgent.includes('Mac') && (
        <SettingRow
          label="Native macOS window tabs"
          description="Group main windows as native tabs in the title bar. Restart required."
        >
          <Toggle checked={store.nativeTabs} onChange={(v) => store.setSetting('nativeTabs', v)} />
        </SettingRow>
      )}
    </div>
  )
}
