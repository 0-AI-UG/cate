// =============================================================================
// BrowserSettingsPopover — an in-panel settings surface for a browser panel,
// reusing the app's SettingRow/TextInput/Select/Toggle controls. Edits the same
// global AppSettings the main Settings window does, plus a "Clear browsing data"
// action. Opened from the URL-bar overflow (⋮) menu.
// =============================================================================
import { useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, Select, Toggle, SecondaryButton } from '../settings/SettingsComponents'
import type { BrowserSearchEngine, BrowserNewTabBehavior } from '../../shared/types'

interface Props {
  onClose: () => void
  onClearData: () => void
}

export function BrowserSettingsPopover({ onClose, onClearData }: Props): JSX.Element {
  const store = useSettingsStore()
  const ref = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)

  // Close on click-outside / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="absolute right-2 top-12 z-40 w-80 rounded-lg border border-subtle bg-surface-2 shadow-2xl p-3"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-primary">Browser settings</span>
        <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded hover:bg-hover text-muted" aria-label="Close">
          <X size={13} />
        </button>
      </div>

      <SettingRow label="Homepage">
        <TextInput
          value={store.browserHomepage}
          onChange={(v) => store.setSetting('browserHomepage', v)}
          placeholder="Start page"
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

      <SettingRow label="Show bookmarks bar">
        <Toggle
          checked={store.browserShowBookmarksBar}
          onChange={(v) => store.setSetting('browserShowBookmarksBar', v)}
        />
      </SettingRow>

      <div className="flex items-center justify-between py-2.5">
        <div className="flex flex-col min-w-0">
          <span className="text-sm text-primary">Clear browsing data</span>
          <span className="text-xs text-muted mt-0.5">History, cookies & cache (shared by all panels)</span>
        </div>
        <div className="flex-shrink-0 ml-4">
          <SecondaryButton onClick={() => { if (confirming) onClearData(); else setConfirming(true) }}>
            {confirming ? 'Confirm clear' : 'Clear…'}
          </SecondaryButton>
        </div>
      </div>
    </div>
  )
}
