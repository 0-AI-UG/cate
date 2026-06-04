import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserSearchEngine, TerminalLinkOpenTarget } from '../../shared/types'
import { SettingRow, TextInput, Select } from './SettingsComponents'

export function BrowserSettings() {
  const store = useSettingsStore()

  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Homepage">
        <TextInput
          value={store.browserHomepage}
          onChange={(v) => store.setSetting('browserHomepage', v)}
          placeholder="about:blank"
        />
      </SettingRow>
      <SettingRow label="Search engine">
        <Select
          value={store.browserSearchEngine}
          onChange={(v) => store.setSetting('browserSearchEngine', v as BrowserSearchEngine)}
          options={[
            { value: 'google', label: 'Google' },
            { value: 'duckDuckGo', label: 'DuckDuckGo' },
            { value: 'bing', label: 'Bing' },
            { value: 'brave', label: 'Brave' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Open terminal links"
        description="Where Cmd/Ctrl+click on a terminal link opens. Cmd/Ctrl+Shift+click always uses the system browser."
      >
        <Select
          value={store.terminalLinkOpenTarget}
          onChange={(v) => store.setSetting('terminalLinkOpenTarget', v as TerminalLinkOpenTarget)}
          options={[
            { value: 'ask', label: 'Ask each time' },
            { value: 'canvas', label: 'On canvas' },
            { value: 'external', label: 'In system browser' },
          ]}
        />
      </SettingRow>
    </div>
  )
}
