import { useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Toggle, SearchableBlock } from './SettingsComponents'
import { StringListEditor } from './StringListEditor'

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
        description="Discarding a worktree also closes its terminals, agents, files, documents, and reviews."
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

          <StringListEditor
            values={paths}
            draft={draft}
            onDraftChange={(value) => { setDraft(value); if (error) setError(null) }}
            onAdd={add}
            onRemove={remove}
            placeholder="Add a path, e.g. node_modules"
            error={error}
          />
        </div>
      </SearchableBlock>
    </div>
  )
}
