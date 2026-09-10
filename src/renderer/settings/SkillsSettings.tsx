// =============================================================================
// SkillsSettings — manage the skill catalog SOURCES (user-added repos).
// Sources are global (userData), shared across every workspace, so they live here in main Settings. The Skills dialog's gear button
// deep-links to this section. Browsing / saving / installing skills happens in
// the Skills dialog (left-rail puzzle button), not here.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { Github as GithubLogo, Plus, Trash } from 'lucide-react'
import { SettingRow, SearchableBlock, SecondaryButton, TextInput } from './SettingsComponents'
import { useUIStore } from '../stores/uiStore'
import { errorMessage } from '../lib/errorMessage'
import type { SkillSource } from '../../shared/skills'
import { Tooltip } from '../ui/Tooltip'
import { InlineNotice } from '../ui/InlineNotice'

const api = () => window.electronAPI

export function SkillsSettings() {
  const [sources, setSources] = useState<SkillSource[]>([])
  const [repo, setRepo] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSources(await api().skillsListSources())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const add = async () => {
    const value = repo.trim()
    if (!value) return
    setAdding(true)
    setErr(null)
    try {
      const res = await api().skillsAddSource(value)
      if (!res.ok) setErr(errorMessage(res.error, 'Could not add that repository.'))
      else {
        setRepo('')
        await refresh()
      }
    } finally {
      setAdding(false)
    }
  }

  const remove = async (id: string) => {
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      return
    }
    await api().skillsRemoveSource(id)
    setConfirmRemoveId(null)
    await refresh()
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Add repository"
        description="GitHub repos of skills, searched alongside the built-in catalog and shared across workspaces."
      >
        <div className="flex items-center gap-2">
          <TextInput
            value={repo}
            onChange={setRepo}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="owner/repo"
            className="font-mono"
          />
          <SecondaryButton onClick={() => void add()} disabled={!repo.trim()} loading={adding} loadingLabel="Adding…">
            <Plus size={11} />
            Add
          </SecondaryButton>
        </div>
      </SettingRow>

      {err && <InlineNotice tone="error" className="-mt-1 mb-1 border-0 bg-transparent px-0">{err}</InlineNotice>}

      {sources.length > 0 && (
        <SearchableBlock keywords={`skills sources repositories github repo catalog list ${sources.map((source) => source.repo).join(' ')}`}>
          <div className="my-2">
            {sources.map((s) => (
              <div
                key={s.id}
                className="group flex items-center gap-2.5 py-2 border-b border-subtle last:border-0 hover:bg-hover"
              >
                <GithubLogo size={14} className="text-muted shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] text-primary font-mono truncate">{s.repo}</span>
                {s.path && <span className="text-[11px] text-muted font-mono truncate">/{s.path}</span>}
                <Tooltip label={confirmRemoveId === s.id ? 'Confirm removal' : 'Remove'}>
                  <button
                    onClick={() => void remove(s.id)}
                    className="shrink-0 p-0.5 rounded-lg text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                    aria-label={confirmRemoveId === s.id ? 'Confirm removal' : 'Remove'}
                  >
                    <Trash size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        </SearchableBlock>
      )}

      <SettingRow
        label="GitHub account"
        description="Skills use your GitHub sign-in for private repositories and higher rate limits. Public skills also work without signing in."
      >
        <SecondaryButton onClick={() => useUIStore.getState().openSettings('GitHub')}>
          Manage GitHub account
        </SecondaryButton>
      </SettingRow>

    </div>
  )
}
