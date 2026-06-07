import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, Slider } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

export function SidebarSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label={t('sidebar.showOnLaunch')}>
        <Toggle checked={store.showFileExplorerOnLaunch} onChange={(v) => store.setSetting('showFileExplorerOnLaunch', v)} />
      </SettingRow>
      <SettingRow label={t('sidebar.tintOpacity')} description={`${Math.round(store.sidebarTintOpacity * 100)}%`}>
        <Slider value={store.sidebarTintOpacity} onChange={(v) => store.setSetting('sidebarTintOpacity', v)} min={0.3} max={1.0} step={0.05} />
      </SettingRow>
    </div>
  )
}
