// =============================================================================
// ModelPicker — provider-grouped dropdown for the AgentPanel header. Searchable,
// collapsible per provider, with a "Manage providers…" escape hatch.
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import { MagnifyingGlass, CaretRight, CaretDown, CheckCircle } from '@phosphor-icons/react'
import type { AgentModelRef } from '../../shared/types'

export function ModelPicker({
  models,
  selected,
  onPick,
  onClose,
  onManage,
}: {
  models: Array<{ provider: string; model: string; label?: string }>
  selected: AgentModelRef | null
  onPick: (m: { provider: string; model: string }) => void
  onClose: () => void
  onManage: () => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return models
    return models.filter((m) =>
      m.provider.toLowerCase().includes(q) ||
      m.model.toLowerCase().includes(q) ||
      (m.label?.toLowerCase().includes(q) ?? false),
    )
  }, [models, search])

  const grouped = useMemo(() => {
    const out = new Map<string, typeof models>()
    for (const m of filtered) {
      const arr = out.get(m.provider) ?? []
      arr.push(m)
      out.set(m.provider, arr)
    }
    return Array.from(out.entries())
  }, [filtered])

  // Collapse all providers by default except the one owning the current
  // selection. Searching auto-expands everything so matches are visible.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const all = new Set<string>()
    for (const m of models) all.add(m.provider)
    if (selected) all.delete(selected.provider)
    return all
  })
  const toggleProvider = (provider: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }
  const searching = search.trim().length > 0

  return (
    <div
      ref={wrapRef}
      className="absolute top-full left-0 mt-1 w-[280px] max-h-[360px] flex flex-col rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-20"
    >
      <div className="px-2 py-2 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/20 border border-white/5">
          <MagnifyingGlass size={11} className="text-muted shrink-0" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models"
            className="flex-1 bg-transparent text-[11px] text-primary placeholder:text-muted outline-none min-w-0"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
      {grouped.length === 0 ? (
        <div className="px-3 py-4 text-[12px] text-muted text-center">
          {models.length === 0 ? 'No models connected yet.' : 'No matches.'}
        </div>
      ) : (
        grouped.map(([provider, items]) => {
          const isCollapsed = !searching && collapsed.has(provider)
          return (
            <div key={provider}>
              <button
                type="button"
                onClick={() => toggleProvider(provider)}
                className="w-full flex items-center gap-1 px-3 py-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold sticky top-0 bg-surface-4/98 hover:text-primary"
              >
                {isCollapsed
                  ? <CaretRight size={9} className="shrink-0" />
                  : <CaretDown size={9} className="shrink-0" />}
                <span className="flex-1 text-left">{provider}</span>
                <span className="text-muted/50 normal-case tracking-normal">{items.length}</span>
              </button>
              {!isCollapsed && items.map((m) => {
                const isSelected =
                  selected?.provider === m.provider && selected?.model === m.model
                return (
                  <button
                    key={`${m.provider}:${m.model}`}
                    onClick={() => onPick(m)}
                    className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
                      isSelected ? 'bg-white/10 text-primary' : 'text-primary hover:bg-white/5'
                    }`}
                  >
                    <span className="truncate flex-1">{m.label ?? m.model}</span>
                    {isSelected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
                  </button>
                )
              })}
            </div>
          )
        })
      )}
      </div>
      <div className="border-t border-white/10 shrink-0">
        <button
          onClick={onManage}
          className="w-full text-left px-3 py-1.5 text-[12px] text-agent-light hover:bg-white/5"
        >
          Manage providers…
        </button>
      </div>
    </div>
  )
}
