import { useState } from 'react'
import { Plus, X, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { SearchableBlock, SettingRow } from './SettingsComponents'
import { useTranslation } from '../hooks/useTranslation'

function sameAsDefault(list: string[]): boolean {
  const defaults = DEFAULT_SETTINGS.fileExclusions
  if (list.length !== defaults.length) return false
  const set = new Set(list)
  return defaults.every((name) => set.has(name))
}

export function FileExplorerSettings() {
  const store = useSettingsStore()
  const { t } = useTranslation()
  const folders = store.fileExclusions ?? []
  const fileOpenMode = store.fileOpenMode ?? 'dock'
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const name = draft.trim()
    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      setError(t('fileExplorer.error.path'))
      return
    }
    // Names are matched literally by the explorer/search and turned into globs
    // for the watcher; reject glob metacharacters so all three surfaces agree.
    if (/[*?[\]{}()!]/.test(name)) {
      setError(t('fileExplorer.error.glob'))
      return
    }
    if (folders.includes(name)) {
      setError(`"${name}" ${t('fileExplorer.error.duplicate')}`)
      return
    }
    store.setSetting('fileExclusions', [...folders, name])
    setDraft('')
    setError(null)
  }

  const remove = (name: string) => {
    store.setSetting('fileExclusions', folders.filter((f) => f !== name))
  }

  const restore = () => {
    store.setSetting('fileExclusions', [...DEFAULT_SETTINGS.fileExclusions])
    setError(null)
  }

  return (
    <>
    <SettingRow
      label={t('fileExplorer.openMode')}
      description={t('fileExplorer.openMode.desc')}
    >
      <select
        value={fileOpenMode}
        onChange={(e) => store.setSetting('fileOpenMode', e.target.value as 'canvas' | 'dock')}
        className="bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary focus:border-focus-blue focus:outline-none"
      >
        <option value="dock">{t('fileExplorer.openMode.dock')}</option>
        <option value="canvas">{t('fileExplorer.openMode.canvas')}</option>
      </select>
    </SettingRow>
    <SearchableBlock keywords="file explorer exclusions hidden ignore folders gitignore exclude">
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        {t('fileExplorer.exclusions')}
      </p>

      <div className="flex gap-1.5">
        <input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
          placeholder={t('fileExplorer.addPlaceholder')}
          className="flex-1 bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-focus-blue focus:outline-none"
        />
        <button
          onClick={add}
          className="flex items-center gap-1 px-2.5 py-1 text-[12px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle"
        >
          <Plus size={12} />
          {t('fileExplorer.add')}
        </button>
      </div>

      {error && <div className="text-[11px] text-red-400 mt-2">{error}</div>}

      <div className="flex flex-wrap gap-1.5 mt-3">
        {folders.length === 0 ? (
          <div className="text-[11px] text-muted italic px-0.5 py-1">
            {t('fileExplorer.noExclusions')}
          </div>
        ) : (
          folders.map((name) => (
            <span
              key={name}
              className="group inline-flex items-center gap-1 rounded bg-surface-5 border border-subtle pl-2 pr-1 py-0.5 text-[12px] font-mono text-primary"
            >
              {name}
              <button
                onClick={() => remove(name)}
                className="p-0.5 rounded text-muted hover:text-red-400"
                title={`Remove ${name}`}
              >
                <X size={11} />
              </button>
            </span>
          ))
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-subtle flex justify-end">
        <button
          onClick={restore}
          disabled={sameAsDefault(folders)}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle disabled:opacity-40 disabled:cursor-default disabled:hover:bg-surface-2 disabled:hover:text-secondary"
        >
          <ArrowCounterClockwise size={11} />
          {t('fileExplorer.restoreDefaults')}
        </button>
      </div>
    </div>
    </SearchableBlock>
    </>
  )
}
