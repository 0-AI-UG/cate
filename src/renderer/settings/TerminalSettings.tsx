import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, NumberInput } from './SettingsComponents'

export function TerminalSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-white/40 mb-3">
        Leave fields blank to use system defaults.
      </p>
      <SettingRow label="Font family override">
        <TextInput
          value={store.terminalFontFamily}
          onChange={(v) => store.setSetting('terminalFontFamily', v)}
          placeholder="e.g., Menlo, Monaco"
        />
      </SettingRow>
      <SettingRow label="Font size override" description="0 = use default">
        <NumberInput
          value={store.terminalFontSize}
          onChange={(v) => store.setSetting('terminalFontSize', v)}
          min={0}
          max={32}
          step={1}
        />
      </SettingRow>
    </div>
  )
}
