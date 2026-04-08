import { useSettingsStore } from '../stores/settingsStore'
import type { AppearanceMode } from '../../shared/types'
import { SettingRow, Select, NumberInput } from './SettingsComponents'

export function AppearanceSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Theme">
        <Select
          value={store.appearanceMode}
          onChange={(v) => store.setSetting('appearanceMode', v as AppearanceMode)}
          options={[
            { value: 'system', label: 'System' },
            { value: 'dark-warm', label: 'Dark — Warm' },
            { value: 'dark-cold', label: 'Dark — Cold' },
            { value: 'light-subtle', label: 'Light — Subtle' },
          ]}
        />
      </SettingRow>
      <SettingRow label="Editor font size">
        <NumberInput value={store.editorFontSize} onChange={(v) => store.setSetting('editorFontSize', v)} min={8} max={32} step={1} />
      </SettingRow>
    </div>
  )
}
