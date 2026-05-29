import { useState } from 'react'
import { Plus, X, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { DEFAULT_SETTINGS } from '../../shared/types'

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
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Folders and files with these exact names are hidden from the file
        explorer, file search, and change watching. Applies to every project.
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
          placeholder="Add a name, e.g. dist"
          className="flex-1 bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-focus-blue focus:outline-none"
        />
        <button
          onClick={add}
          className="flex items-center gap-1 px-2.5 py-1 text-[12px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle"
        >
          <Plus size={12} />
          Add
        </button>
      </div>

      {error && <div className="text-[11px] text-red-400 mt-2">{error}</div>}

      <div className="flex flex-wrap gap-1.5 mt-3">
        {folders.length === 0 ? (
          <div className="text-[11px] text-muted italic px-0.5 py-1">
            No exclusions — every file and folder is shown.
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
          Restore defaults
        </button>
      </div>
    </div>
  )
}
