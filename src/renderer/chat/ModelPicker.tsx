import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { MagnifyingGlass, CaretRight, CaretDown, CheckCircle } from '@phosphor-icons/react'
import type { CateAgentModelRef } from '../../shared/types'
import { useDismissableLayer } from '../ui/Popover'

export type ModelOption = { provider: string; model: string; label?: string }

type ModelPickerDropdownProps = {
  models: ModelOption[]
  selected: CateAgentModelRef | null
  onClose: () => void
  className?: string
  style?: CSSProperties
  onManage?: () => void
  triggerRef?: RefObject<HTMLElement | null>
} & (
  | { allowNone: true; noneLabel: string; onPick: (model: ModelOption | null) => void }
  | { allowNone?: false; noneLabel?: undefined; onPick: (model: ModelOption) => void }
)

export function ModelPickerDropdown({
  models,
  selected,
  onPick,
  onClose,
  className = 'top-full mt-1 left-0 w-[280px] max-h-[360px]',
  style,
  allowNone = false,
  noneLabel,
  onManage,
  triggerRef,
}: ModelPickerDropdownProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  useDismissableLayer({
    open: true,
    contentRef: wrapRef,
    triggerRefs: triggerRef ? [triggerRef] : [],
    onDismiss: onClose,
    outsideEvent: 'click',
  })

  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => { searchRef.current?.focus() }, [])

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return models
    return models.filter((model) =>
      model.provider.toLowerCase().includes(query)
      || model.model.toLowerCase().includes(query)
      || (model.label?.toLowerCase().includes(query) ?? false),
    )
  }, [models, search])

  const grouped = useMemo(() => {
    const result = new Map<string, ModelOption[]>()
    for (const model of filtered) {
      const entries = result.get(model.provider) ?? []
      entries.push(model)
      result.set(model.provider, entries)
    }
    return Array.from(result.entries())
  }, [filtered])

  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const providers = new Set(models.map((model) => model.provider))
    if (selected) providers.delete(selected.provider)
    return providers
  })
  const toggleProvider = (provider: string): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(provider)) next.delete(provider)
      else next.add(provider)
      return next
    })
  }
  const searching = search.trim().length > 0

  return (
    <div
      ref={wrapRef}
      style={style}
      className={`absolute ${className} z-20 flex flex-col rounded-lg border border-strong bg-surface-4/98 shadow-[0_12px_32px_var(--shadow-node)] backdrop-blur-xl`}
    >
      <div className="shrink-0 border-b border-strong px-2 py-2">
        <div className="flex items-center gap-1.5 rounded-md border border-subtle bg-surface-0 px-2 py-1">
          <MagnifyingGlass size={11} className="shrink-0 text-muted" />
          <input
            ref={searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
            className="min-w-0 flex-1 bg-transparent text-[11px] text-primary outline-none placeholder:text-muted"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {allowNone && (
          <button
            type="button"
            onClick={() => (onPick as (model: ModelOption | null) => void)(null)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
              !selected ? 'bg-hover-strong text-primary' : 'text-muted hover:bg-hover'
            }`}
          >
            <span className="min-w-0 flex-1 truncate">{noneLabel}</span>
            {!selected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
          </button>
        )}
        {grouped.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-muted">
            {models.length === 0 ? 'No models connected yet.' : 'No matches.'}
          </div>
        ) : grouped.map(([provider, entries]) => {
          const isCollapsed = !searching && collapsed.has(provider)
          return (
            <div key={provider}>
              <button
                type="button"
                aria-expanded={!isCollapsed}
                onClick={() => toggleProvider(provider)}
                className="sticky top-0 flex w-full items-center gap-1 bg-surface-4/98 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted/70 hover:text-primary"
              >
                {isCollapsed ? <CaretRight size={9} /> : <CaretDown size={9} />}
                <span className="flex-1 text-left">{provider}</span>
                <span className="text-muted/50 normal-case tracking-normal">{entries.length}</span>
              </button>
              {!isCollapsed && entries.map((model) => {
                const isSelected = selected?.provider === model.provider && selected?.model === model.model
                return (
                  <button
                    key={`${model.provider}:${model.model}`}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onPick(model)}
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                      isSelected ? 'bg-hover-strong text-primary' : 'text-primary hover:bg-hover'
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate">{model.label ?? model.model}</span>
                    {isSelected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
      {onManage && (
        <div className="shrink-0 border-t border-strong">
          <button
            type="button"
            onClick={onManage}
            className="w-full px-3 py-1.5 text-left text-[12px] text-agent-light hover:bg-hover"
          >
            Manage providers…
          </button>
        </div>
      )}
    </div>
  )
}
