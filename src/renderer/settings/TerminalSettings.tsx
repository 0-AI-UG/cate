import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, NumberInput, Toggle } from './SettingsComponents'

export function TerminalSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Leave font fields blank to use system defaults. Terminal colors follow
        the active theme — change it in Appearance.
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
      <SettingRow
        label="Blink cursor"
        description="Off by default. A blinking cursor forces a GPU/compositor redraw on every blink, keeping the compositor awake even when the terminal is otherwise idle. A steady cursor stays fully visible."
      >
        <Toggle
          checked={store.terminalCursorBlink}
          onChange={(v) => store.setSetting('terminalCursorBlink', v)}
        />
      </SettingRow>
      <SettingRow
        label="Auto-suspend idle background terminals"
        description="Pause (SIGSTOP) terminals that have been offscreen and silent for 2 minutes so macOS can reclaim their memory. Resumes instantly on focus — no state loss. POSIX-only."
      >
        <Toggle
          checked={store.autoSuspendIdleTerminals}
          onChange={(v) => store.setSetting('autoSuspendIdleTerminals', v)}
        />
      </SettingRow>
    </div>
  )
}
