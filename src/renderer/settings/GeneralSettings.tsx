import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, TextInput } from './SettingsComponents'

export function GeneralSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Restore session on launch" description="Reopen panels from your last session">
        <Toggle checked={store.restoreSessionOnLaunch} onChange={(v) => store.setSetting('restoreSessionOnLaunch', v)} />
      </SettingRow>
      <SettingRow label="Default shell path">
        <TextInput value={store.defaultShellPath} onChange={(v) => store.setSetting('defaultShellPath', v)} placeholder="/bin/zsh" />
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
