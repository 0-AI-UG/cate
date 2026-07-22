// =============================================================================
// ModelPickerDropdown — provider-grouped dropdown for selecting an agent model.
// Searchable, collapsible per provider. Shared by the CateAgentPanel header (with a
// "Manage providers…" footer) and the Settings default-model picker (with a
// "First available" none row). Each call site overrides size via className.
// =============================================================================

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { MagnifyingGlass, CaretRight, CaretDown, CheckCircle } from '@phosphor-icons/react'
import type { CateAgentModelRef } from '../../shared/types'

type ModelOption = { provider: string; model: string; label?: string }

type ModelPickerDropdownProps = {
  models: ModelOption[]
  selected: CateAgentModelRef | null
  onClose: () => void
  /** Override the container placement + sizing (e.g. `top-full mt-1 left-0
   *  w-[280px] max-h-[360px]`). Carries the vertical anchor too, so a call site
   *  at the bottom of its panel can open upward with `bottom-full mb-1`. */
  className?: string
  /** Footer action (renders a "Manage providers…" button when provided). */
  onManage?: () => void
  /** The button that toggles this dropdown. A mousedown on it is not treated as
   *  an outside click, so the trigger's own onClick can toggle the dropdown
   *  closed instead of the outside-handler closing it and the click reopening it. */
  triggerRef?: RefObject<HTMLElement | null>
} & (
  | {
      /** When true, render a top "none" row that calls onPick(null). */
      allowNone: true
      noneLabel: string
      onPick: (m: ModelOption | null) => void
    }
  | {
      allowNone?: false
      noneLabel?: undefined
      onPick: (m: ModelOption) => void
    }
)

export function ModelPickerDropdown({
  models,
  selected,
  onPick,
  onClose,
  className = 'top-full mt-1 left-0 w-[280px] max-h-[360px]',
  allowNone = false,
  noneLabel,
  onManage,
  triggerRef,
}: ModelPickerDropdownProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return
      const target = e.target as Node
      if (wrapRef.current.contains(target)) return
      if (triggerRef?.current?.contains(target)) return
      onClose()
    }
    // Dismiss after the target's own click handler has run. Closing on
    // mousedown races toggle buttons: mousedown closes, then click reopens.
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose, triggerRef])

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
    const out = new Map<string, ModelOption[]>()
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
      className={`absolute ${className} flex flex-col rounded-lg border border-strong bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_var(--shadow-node)] z-20`}
    >
      <div className="px-2 py-2 border-b border-strong shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-0 border border-subtle">
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
      {allowNone && (
        <button
          onClick={() => (onPick as (m: ModelOption | null) => void)(null)}
          className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
            !selected ? 'bg-hover-strong text-primary' : 'text-muted hover:bg-hover'
          }`}
        >
          <span className="truncate flex-1">{noneLabel}</span>
          {!selected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
        </button>
      )}
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
                      isSelected ? 'bg-hover-strong text-primary' : 'text-primary hover:bg-hover'
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
      {onManage && (
        <div className="border-t border-strong shrink-0">
          <button
            onClick={onManage}
            className="w-full text-left px-3 py-1.5 text-[12px] text-agent-light hover:bg-hover"
          >
            Manage providers…
          </button>
        </div>
      )}
    </div>
  )
}
