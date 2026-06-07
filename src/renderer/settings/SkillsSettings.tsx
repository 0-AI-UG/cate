// =============================================================================
// SkillsSettings — manage the skill catalog SOURCES (user-added repos) and the
// optional GitHub token. Sources are global (userData), shared across every
// workspace, so they live here in main Settings. The Skills dialog's gear button
// deep-links to this section. Browsing / saving / installing skills happens in
// the Skills dialog (left-rail puzzle button), not here.
// =============================================================================

import { useCallback, useEffect, useState } from 'react'
import { GithubLogo, Plus, Trash } from '@phosphor-icons/react'
import { SettingRow, SearchableBlock } from './SettingsComponents'
import { errorMessage } from '../lib/errorMessage'
import type { SkillSource } from '../../shared/skills'

const api = () => window.electronAPI

const SMALL_BTN =
  'flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle disabled:opacity-40 disabled:cursor-default'
const INPUT =
  'w-48 bg-surface-5 border border-subtle rounded-md px-2 py-1 text-sm text-primary placeholder:text-muted focus:border-focus-blue focus:outline-none'

export function SkillsSettings() {
  const [sources, setSources] = useState<SkillSource[]>([])
  const [repo, setRepo] = useState('')
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [hasToken, setHasToken] = useState(false)
  const [token, setToken] = useState('')

  const refresh = useCallback(async () => {
    try {
      setSources(await api().skillsListSources())
      setHasToken((await api().skillsGetToken()).hasToken)
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
    await api().skillsRemoveSource(id)
    await refresh()
  }

  const saveToken = async () => {
    await api().skillsSetToken(token.trim() || null)
    setToken('')
    await refresh()
  }

  const clearToken = async () => {
    await api().skillsSetToken(null)
    setToken('')
    await refresh()
  }

  return (
    <div className="flex flex-col gap-1">
      <SettingRow
        label="Add repository"
        description="GitHub repos of skills, searched alongside the built-in catalog and shared across workspaces."
      >
        <div className="flex items-center gap-2">
          <input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
            placeholder="owner/repo"
            className={`${INPUT} font-mono`}
          />
          <button onClick={() => void add()} disabled={adding || !repo.trim()} className={SMALL_BTN}>
            <Plus size={11} />
            Add
          </button>
        </div>
      </SettingRow>

      {err && <div className="text-[11px] text-red-400 -mt-1 mb-1">{err}</div>}

      {sources.length > 0 && (
        <SearchableBlock keywords="skills sources repositories github repo catalog list">
          <div className="my-2 rounded-lg border border-subtle overflow-hidden">
            {sources.map((s) => (
              <div
                key={s.id}
                className="group flex items-center gap-2.5 px-3 py-2 border-b border-subtle last:border-0 hover:bg-hover"
              >
                <GithubLogo size={14} className="text-muted shrink-0" />
                <span className="flex-1 min-w-0 text-[12px] text-primary font-mono truncate">{s.repo}</span>
                {s.path && <span className="text-[11px] text-muted font-mono truncate">/{s.path}</span>}
                <button
                  onClick={() => void remove(s.id)}
                  className="shrink-0 p-0.5 rounded text-muted opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
                  title="Remove"
                >
                  <Trash size={12} />
                </button>
              </div>
            ))}
          </div>
        </SearchableBlock>
      )}

      <SettingRow
        label="GitHub token"
        description="Optional. Raises the rate limit (60→5,000/hr) and allows private repos. Stored locally."
        hint={hasToken ? <span className="text-[10px] text-emerald-400">Token saved</span> : undefined}
      >
        <div className="flex items-center gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={hasToken ? 'Replace…' : 'ghp_…'}
            className={INPUT}
          />
          <button onClick={() => void saveToken()} disabled={!token.trim()} className={SMALL_BTN}>
            Save
          </button>
          {hasToken && (
            <button onClick={() => void clearToken()} className="px-2 py-1 text-[11px] rounded text-muted hover:text-red-400">
              Clear
            </button>
          )}
        </div>
      </SettingRow>

    </div>
  )
}
