import { useSettingsStore } from '../stores/settingsStore'
import type { BrowserSearchEngine, TerminalUrlAutoOpenMode } from '../../shared/types'
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
        label="URLs from terminal"
        description="What to do when a localhost or http(s) URL appears in terminal output. Off ignores them. Automatic opens each URL once in an existing browser panel (or a new one). Ask shows an inline prompt at the bottom of the terminal."
      >
        <Select
          value={store.autoOpenUrlsFromTerminal}
          onChange={(v) => store.setSetting('autoOpenUrlsFromTerminal', v as TerminalUrlAutoOpenMode)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'auto', label: 'Automatic' },
            { value: 'prompt', label: 'Ask before opening' },
          ]}
        />
      </SettingRow>
    </div>
  )
}
