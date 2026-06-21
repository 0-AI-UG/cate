import { useState } from 'react'
import { Plus, X } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, SearchableBlock, TextInput } from './SettingsComponents'

export function WorktreeSettings() {
  const store = useSettingsStore()
  const paths = store.worktreeSymlinkPaths ?? []
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const add = () => {
    // Normalize: trim, drop leading slashes — entries are workspace-root-relative.
    const name = draft.trim().replace(/^[/\\]+/, '')
    if (!name) return
    if (name.split(/[/\\]/).includes('..')) {
      setError('Paths cannot escape the workspace root with "..".')
      return
    }
    if (paths.includes(name)) {
      setError(`"${name}" is already in the list.`)
      return
    }
    store.setSetting('worktreeSymlinkPaths', [...paths, name])
    setDraft('')
    setError(null)
  }

  const remove = (name: string) => {
    store.setSetting('worktreeSymlinkPaths', paths.filter((p) => p !== name))
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Close panels when discarding a worktree"
        description="Discarding a worktree also closes its terminals and agent panels."
      >
        <Toggle
          checked={store.closeWorktreePanelsOnDelete}
          onChange={(v) => store.setSetting('closeWorktreePanelsOnDelete', v)}
        />
      </SettingRow>

      <SearchableBlock keywords="worktree symlink node_modules link paths build artifacts">
        <div className="flex flex-col gap-1 pt-3">
          <p className="text-xs text-muted mb-3">
            Paths symlinked from the workspace root into every new worktree (e.g.
            node_modules) so they don't need rebuilding. Leave empty to disable.
          </p>

          <div className="flex gap-1.5">
            <TextInput
              value={draft}
              onChange={(value) => {
                setDraft(value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add()
              }}
              placeholder="Add a path, e.g. node_modules"
              layoutClassName="flex-1 px-2"
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

          {paths.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {paths.map((name) => (
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
              ))}
            </div>
          )}
        </div>
      </SearchableBlock>
    </div>
  )
}
