import { useEffect, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import type {
  BrowserNewTabBehavior,
  BrowserSearchEngine,
  TerminalLinkOpenTarget,
} from '../../shared/types'
import { SettingRow, TextInput, Select, SecondaryButton } from './SettingsComponents'

export function BrowserSettings() {
  const store = useSettingsStore()
  const [confirmingClearData, setConfirmingClearData] = useState(false)
  const [browsingDataMessage, setBrowsingDataMessage] = useState('')
  const [proxyDraft, setProxyDraft] = useState(store.browserProxyUrl)

  useEffect(() => {
    setProxyDraft(store.browserProxyUrl)
  }, [store.browserProxyUrl])

  const saveProxy = () => {
    const value = proxyDraft.trim()
    setProxyDraft(value)
    if (value !== store.browserProxyUrl) store.setSetting('browserProxyUrl', value)
  }

  const clearBrowsingData = async () => {
    if (!confirmingClearData) {
      setConfirmingClearData(true)
      setBrowsingDataMessage('')
      return
    }
    await window.electronAPI.browserClearData()
    setConfirmingClearData(false)
    setBrowsingDataMessage('Browsing data cleared.')
  }

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
      <SettingRow label="New tab opens">
        <Select
          value={store.browserNewTabBehavior}
          onChange={(v) => store.setSetting('browserNewTabBehavior', v as BrowserNewTabBehavior)}
          options={[
            { value: 'startPage', label: 'Start page' },
            { value: 'homepage', label: 'Homepage' },
          ]}
        />
      </SettingRow>
      <SettingRow
        label="Proxy"
        description="Used by every browser panel. Leave empty for a direct connection. Supports authenticated proxy URLs, PAC scripts, and ;bypass= lists."
      >
        <TextInput
          value={proxyDraft}
          onChange={setProxyDraft}
          onBlur={saveProxy}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
          }}
          placeholder="http://proxy.company.com:8080"
          layoutClassName="w-72 px-2"
          className="font-mono"
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
      <SettingRow
        label="Clear browsing data"
        description="History, cookies and cache shared by all browser panels."
        hint={browsingDataMessage
          ? <span className="text-xs text-muted">{browsingDataMessage}</span>
          : undefined}
      >
        <SecondaryButton onClick={() => void clearBrowsingData()}>
          {confirmingClearData ? 'Confirm clear' : 'Clear…'}
        </SecondaryButton>
      </SettingRow>
    </div>
  )
}
