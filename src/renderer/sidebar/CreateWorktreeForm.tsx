// =============================================================================
// CreateWorktreeForm — "what are you working on?" form for starting a new
// parallel branch. Extracted from ParallelWorkTab so it can be reused both in
// the sidebar (Parallel Work tab) and the canvas toolbar's worktree drop-up.
//
// Purely presentational: it owns the name input + base-branch / PR picker and
// reports the user's choice back through onSubmit / onCheckoutPr. The actual
// git + store work lives in useWorktreeActions.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GitBranch,
  Check,
  X,
  CaretRight,
  CaretDown,
  GitPullRequest,
} from '@phosphor-icons/react'

export interface PrListItem {
  number: number
  title: string
  headRefName: string
  author: string
  isFork: boolean
}

export const CreateWorktreeForm: React.FC<{
  onSubmit: (name: string, baseRef?: string) => Promise<void>
  onCheckoutPr: (pr: PrListItem) => Promise<void>
  onCancel: () => void
  defaultBaseBranch: string
  rootPath: string
  /** Which way the floating base-branch / PR picker opens. Defaults to 'down'
   *  (sidebar). Ignored when `inlinePicker` is set. */
  pickerPlacement?: 'up' | 'down'
  /** When true the picker expands inline — growing the dialog height with a
   *  smooth transition — instead of floating in an absolute dropdown. Used by
   *  the canvas drop-up, where a floating layer would spill out of the menu. */
  inlinePicker?: boolean
  /** When true the input + picker drop their solid card surfaces and blend into
   *  the surrounding panel (used inside the translucent canvas drop-up, where
   *  nested cards look heavy). */
  flat?: boolean
}> = ({
  onSubmit,
  onCheckoutPr,
  onCancel,
  defaultBaseBranch,
  rootPath,
  pickerPlacement = 'down',
  inlinePicker = false,
  flat = false,
}) => {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [baseRef, setBaseRef] = useState<string>('')
  const [branches, setBranches] = useState<Array<{ name: string; isRemote: boolean }>>([])
  const [prs, setPrs] = useState<PrListItem[]>([])
  const [selectedPr, setSelectedPr] = useState<PrListItem | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [localExpanded, setLocalExpanded] = useState(true)
  const [remoteExpanded, setRemoteExpanded] = useState(false)
  const [prsExpanded, setPrsExpanded] = useState(true)
  const [filter, setFilter] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    window.electronAPI.gitPrList(rootPath).then((list) => {
      if (!cancelled) setPrs(list)
    }).catch(() => {})
    window.electronAPI.gitBranchList(rootPath).then((result) => {
      if (cancelled) return
      setBranches(
        result.branches
          .filter((b) => !b.name.includes('/HEAD'))
          .map((b) => ({ name: b.name, isRemote: b.isRemote })),
      )
    }).catch(() => {})
    return () => { cancelled = true }
  }, [rootPath])

  useEffect(() => {
    if (!pickerOpen) return
    filterRef.current?.focus()
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const displayBase = baseRef || defaultBaseBranch || 'HEAD'

  const { localBranches, remoteBranches } = useMemo(() => {
    const q = filter.toLowerCase()
    const filtered = q ? branches.filter((b) => b.name.toLowerCase().includes(q)) : branches
    return {
      localBranches: filtered.filter((b) => !b.isRemote),
      remoteBranches: filtered.filter((b) => b.isRemote),
    }
  }, [branches, filter])

  const filteredPrs = useMemo(() => {
    const q = filter.toLowerCase()
    if (!q) return prs
    return prs.filter((p) =>
      `#${p.number} ${p.title} ${p.headRefName} ${p.author}`.toLowerCase().includes(q),
    )
  }, [prs, filter])

  const canSubmit = selectedPr ? true : !!name.trim()

  const submit = useCallback(async () => {
    if (busy || !canSubmit) return
    setBusy(true)
    setError(null)
    try {
      if (selectedPr) {
        await onCheckoutPr(selectedPr)
      } else {
        await onSubmit(name.trim(), baseRef || undefined)
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to create')
    } finally {
      setBusy(false)
    }
  }, [busy, canSubmit, selectedPr, name, baseRef, onSubmit, onCheckoutPr])

  return (
    <div className="px-1 pt-1">
      <div
        className={`flex items-center gap-1 h-8 px-1.5 rounded-lg text-secondary transition-colors ${
          flat ? 'bg-white/[0.05] focus-within:bg-white/[0.08]' : 'bg-surface-3 focus-within:bg-surface-4'
        }`}
      >
        {selectedPr ? (
          <GitPullRequest size={14} weight="bold" className="flex-shrink-0 opacity-60 ml-1" />
        ) : (
          <GitBranch size={14} weight="bold" className="flex-shrink-0 opacity-60 ml-1" />
        )}
        {selectedPr ? (
          <div className="flex-1 min-w-0 flex items-center gap-1.5 text-[14px] text-primary">
            <span className="text-muted tabular-nums flex-shrink-0">#{selectedPr.number}</span>
            <span className="truncate">{selectedPr.title}</span>
          </div>
        ) : (
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
              if (e.key === 'Escape') onCancel()
            }}
            placeholder="What are you working on?"
            disabled={busy}
            className="flex-1 min-w-0 text-[14px] bg-transparent outline-none text-primary placeholder:text-muted"
          />
        )}
        <button
          onClick={submit}
          disabled={!canSubmit || busy}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-hover disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
          title={selectedPr ? 'Check out pull request' : 'Start'}
        >
          <Check size={14} weight="bold" />
        </button>
        <button
          onClick={onCancel}
          className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded text-muted hover:text-primary hover:bg-hover transition-colors"
          title="Cancel"
        >
          <X size={14} weight="bold" />
        </button>
      </div>
      <div className={`relative ${flat ? 'px-1' : 'px-2'} pt-1 pb-1`} ref={pickerRef}>
        <button
          onClick={() => { setPickerOpen((v) => !v); setFilter('') }}
          className="flex items-center gap-0.5 text-[11px] text-muted hover:text-secondary transition-colors"
        >
          {selectedPr ? 'reviewing' : 'based on'}
          <span className="text-secondary ml-0.5 truncate max-w-[160px] inline-block align-bottom">
            {selectedPr ? `#${selectedPr.number} ${selectedPr.headRefName}` : displayBase}
          </span>
          <CaretDown size={10} className="flex-shrink-0 opacity-60" />
        </button>
        {(() => {
          const panel = (
            <div
              className={
                flat
                  ? 'flex flex-col border-t border-subtle'
                  : 'rounded-xl border border-subtle shadow-lg flex flex-col overflow-hidden'
              }
              style={
                flat
                  ? undefined
                  : {
                      background: 'color-mix(in srgb, var(--surface-2) 85%, transparent)',
                      backdropFilter: 'blur(24px) saturate(1.5)',
                      WebkitBackdropFilter: 'blur(24px) saturate(1.5)',
                    }
              }
            >
              <div className="px-2 py-1 border-b border-subtle">
                <input
                  ref={filterRef}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setPickerOpen(false)
                  }}
                  placeholder="Filter branches & PRs…"
                  className="w-full text-[12px] bg-transparent outline-none text-primary placeholder:text-muted"
                />
              </div>
              <div className="overflow-y-auto max-h-[220px]">
                {localBranches.length > 0 && (
                  <div>
                    <button
                      onClick={() => setLocalExpanded((v) => !v)}
                      className="w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[11px] text-muted select-none hover:text-secondary transition-colors"
                    >
                      <CaretRight size={8} className={`flex-shrink-0 ${localExpanded ? 'rotate-90' : ''}`} />
                      Local
                      <span className="text-muted/60 normal-case tracking-normal">({localBranches.length})</span>
                    </button>
                    {localExpanded && localBranches.map((b) => (
                      <button
                        key={b.name}
                        onClick={() => { setBaseRef(b.name); setSelectedPr(null); setPickerOpen(false) }}
                        className={`block w-[calc(100%-8px)] mx-1 text-left px-2 py-1 text-[12px] truncate rounded-lg hover:bg-hover transition-colors ${
                          b.name === (baseRef || defaultBaseBranch) ? 'text-primary bg-hover' : 'text-secondary'
                        }`}
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
                {remoteBranches.length > 0 && (
                  <div>
                    <button
                      onClick={() => setRemoteExpanded((v) => !v)}
                      className={`w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[11px] text-muted select-none hover:text-secondary transition-colors ${localBranches.length > 0 ? 'border-t border-subtle mt-1' : ''}`}
                    >
                      <CaretRight size={8} className={`flex-shrink-0 ${remoteExpanded ? 'rotate-90' : ''}`} />
                      Remote
                      <span className="text-muted/60 normal-case tracking-normal">({remoteBranches.length})</span>
                    </button>
                    {remoteExpanded && remoteBranches.map((b) => (
                      <button
                        key={b.name}
                        onClick={() => { setBaseRef(b.name); setSelectedPr(null); setPickerOpen(false) }}
                        className={`block w-[calc(100%-8px)] mx-1 text-left px-2 py-1 text-[12px] truncate rounded-lg hover:bg-hover transition-colors opacity-70 ${
                          b.name === (baseRef || defaultBaseBranch) ? 'text-primary bg-hover' : 'text-secondary'
                        }`}
                      >
                        {b.name}
                      </button>
                    ))}
                  </div>
                )}
                {filteredPrs.length > 0 && (
                  <div>
                    <button
                      onClick={() => setPrsExpanded((v) => !v)}
                      className={`w-full flex items-center gap-1 px-2 pt-1.5 pb-0.5 text-[11px] text-muted select-none hover:text-secondary transition-colors ${localBranches.length > 0 || remoteBranches.length > 0 ? 'border-t border-subtle mt-1' : ''}`}
                    >
                      <CaretRight size={8} className={`flex-shrink-0 ${prsExpanded ? 'rotate-90' : ''}`} />
                      Pull requests
                      <span className="text-muted/60 normal-case tracking-normal">({filteredPrs.length})</span>
                    </button>
                    {prsExpanded && filteredPrs.map((p) => (
                      <button
                        key={p.number}
                        onClick={() => { setSelectedPr(p); setPickerOpen(false) }}
                        title={p.isFork ? `${p.headRefName} — fork by ${p.author}` : p.headRefName}
                        className={`flex w-[calc(100%-8px)] mx-1 items-center gap-1.5 px-2 py-1 text-[12px] rounded-lg hover:bg-hover transition-colors ${
                          selectedPr?.number === p.number ? 'bg-hover' : ''
                        }`}
                      >
                        <GitPullRequest size={11} weight="bold" className="flex-shrink-0 opacity-50" />
                        <span className="text-muted tabular-nums flex-shrink-0">#{p.number}</span>
                        <span className="truncate flex-1 text-left text-secondary">{p.title}</span>
                        {p.isFork && (
                          <span className="flex-shrink-0 text-[9px] text-muted truncate max-w-[80px]">{p.author}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {localBranches.length === 0 && remoteBranches.length === 0 && filteredPrs.length === 0 && (
                  <div className="px-2 py-2 text-[11px] text-muted text-center">No matches</div>
                )}
              </div>
            </div>
          )
          // Inline (drop-up): expand within the dialog, animating height via the
          // grid 0fr→1fr trick so the panel grows smoothly. Floating (sidebar):
          // an absolute layer that opens up or down.
          return inlinePicker ? (
            <div
              className="grid transition-[grid-template-rows] duration-200 ease-out"
              style={{ gridTemplateRows: pickerOpen ? '1fr' : '0fr' }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="pt-1">{panel}</div>
              </div>
            </div>
          ) : pickerOpen ? (
            <div
              className={`absolute left-0 right-0 z-50 mx-1 ${pickerPlacement === 'up' ? 'bottom-full mb-0.5' : 'top-full mt-0.5'}`}
            >
              {panel}
            </div>
          ) : null
        })()}
      </div>
      {error && (
        <div className="px-2 pb-1 text-[11px] text-red-400/80">{error}</div>
      )}
    </div>
  )
}
