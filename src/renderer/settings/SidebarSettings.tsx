import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, Slider } from './SettingsComponents'

export function SidebarSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Show file explorer on launch">
        <Toggle checked={store.showFileExplorerOnLaunch} onChange={(v) => store.setSetting('showFileExplorerOnLaunch', v)} />
      </SettingRow>
      <SettingRow label="Background opacity" description={`${Math.round(store.sidebarTintOpacity * 100)}%`}>
        <Slider value={store.sidebarTintOpacity} onChange={(v) => store.setSetting('sidebarTintOpacity', v)} min={0.3} max={1.0} step={0.05} />
      </SettingRow>
    </div>
  )
}
