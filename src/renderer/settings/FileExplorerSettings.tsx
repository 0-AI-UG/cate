import { useState } from 'react'
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { SearchableBlock, SecondaryButton } from './SettingsComponents'
import { StringListEditor } from './StringListEditor'

function sameAsDefault(list: string[]): boolean {
  const defaults = DEFAULT_SETTINGS.fileExclusions
  if (list.length !== defaults.length) return false
  const set = new Set(list)
  return defaults.every((name) => set.has(name))
}

export function FileExplorerSettings() {
  const store = useSettingsStore()
  const folders = store.fileExclusions ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    const name = draft.trim()
    if (!name) return
    if (name.includes('/') || name.includes('\\')) {
      setError('Enter a single folder or file name, not a path.')
      return
    }
    // Names are matched literally by the explorer/search and turned into globs
    // for the watcher; reject glob metacharacters so all three surfaces agree.
    if (/[*?[\]{}()!]/.test(name)) {
      setError('Names cannot contain wildcard characters like * ? [ ] { } ( ) !.')
      return
    }
    if (folders.includes(name)) {
      setError(`"${name}" is already excluded.`)
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
    <SearchableBlock keywords="file explorer exclusions hidden ignore folders gitignore exclude">
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Names hidden from the explorer, search, and file watching, in every
        project.
      </p>

      <StringListEditor
        values={folders}
        draft={draft}
        onDraftChange={(value) => { setDraft(value); if (error) setError(null) }}
        onAdd={add}
        onRemove={remove}
        placeholder="Add a name, e.g. dist"
        error={error}
        emptyMessage="No exclusions. Every file and folder is shown."
      />

      <div className="mt-4 pt-3 border-t border-subtle flex justify-end">
        <SecondaryButton onClick={restore} disabled={sameAsDefault(folders)}>
          <ArrowCounterClockwise size={11} />
          Restore defaults
        </SecondaryButton>
      </div>
    </div>
    </SearchableBlock>
  )
}
