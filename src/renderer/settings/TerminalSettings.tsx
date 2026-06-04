import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, NumberInput, Toggle, Slider } from './SettingsComponents'

const IS_MAC = navigator.userAgent.includes('Mac')

export function TerminalSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Leave font fields blank for system defaults. Colors follow the active
        theme; change it in Appearance.
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
      <SettingRow label="Scroll speed" description={`${store.terminalScrollSpeed.toFixed(2)}x`}>
        <Slider
          value={store.terminalScrollSpeed}
          onChange={(v) => store.setSetting('terminalScrollSpeed', v)}
          min={0.25}
          max={3.0}
          step={0.25}
        />
      </SettingRow>
      <SettingRow
        label="Text contrast"
        description={
          store.terminalContrast <= 1
            ? 'Off. Theme colors shown exactly.'
            : `${store.terminalContrast.toFixed(1)}:1. Lifts dim text (4.5 = WCAG AA).`
        }
      >
        {/* Slider max is intentionally below clampContrastRatio's 21 ceiling: above
            ~7:1 almost all text is already forced to near-black/near-white, so the
            extra travel does nothing visible. Step 0.1 matches xterm's internal
            rounding. Hand-edited stored values up to 21 still validate. */}
        <Slider
          value={store.terminalContrast}
          onChange={(v) => store.setSetting('terminalContrast', v)}
          min={1}
          max={7}
          step={0.1}
        />
      </SettingRow>
      <SettingRow
        label="Blink cursor"
        description="A steady cursor avoids a compositor redraw on every blink, saving power when idle."
      >
        <Toggle
          checked={store.terminalCursorBlink}
          onChange={(v) => store.setSetting('terminalCursorBlink', v)}
        />
      </SettingRow>
      {IS_MAC && (
        <SettingRow
          label="Use ⌥ Option as Meta"
          description="On: ⌥+key sends Meta/ESC (e.g. ⌥F / ⌥B word motion). Off: ⌥ types special characters."
        >
          <Toggle
            checked={store.terminalOptionIsMeta}
            onChange={(v) => store.setSetting('terminalOptionIsMeta', v)}
          />
        </SettingRow>
      )}
      <SettingRow
        label="Auto-suspend idle background terminals"
        description="Pause terminals idle and offscreen for 2 minutes to free memory. Resumes instantly on focus."
      >
        <Toggle
          checked={store.autoSuspendIdleTerminals}
          onChange={(v) => store.setSetting('autoSuspendIdleTerminals', v)}
        />
      </SettingRow>
    </div>
  )
}
