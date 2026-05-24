// =============================================================================
// ProvidersView — in-panel UI for managing pi agent provider authentication.
//
// Single-column push navigation: list → detail → back to list, then back to
// chat. The back arrow is the only way out: from the detail it pops to the
// list, and from the list it returns to the chat.
//
// Only pi's built-in providers are supported. Custom OpenAI-compatible
// endpoints would belong in pi's models.json — out of scope here.
// =============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Eye,
  EyeSlash,
  CheckCircle,
  CircleDashed,
  ArrowSquareOut,
  Copy,
  Spinner,
  CloudArrowUp,
  CaretRight,
  CaretDown,
  MagnifyingGlass,
  Sparkle,
} from '@phosphor-icons/react'
import log from '../../renderer/lib/logger'
import type {
  AgentModelRef,
  AuthProviderDescriptor,
  AuthProviderStatus,
  OAuthFlowEvent,
} from '../../shared/types'
import { loadDefaultModel, saveDefaultModel } from './agentModelPrefs'

interface ProvidersViewProps {
  /** Called when the user pops past the list (returns to chat). Ignored when embedded. */
  onBack?: () => void
  /** When set, the view opens focused on this provider id (skips the list). */
  scopedProviderId?: string
  /** When true, render without the outer header (parent owns navigation). */
  embedded?: boolean
}

export function ProvidersView({ onBack, scopedProviderId, embedded = false }: ProvidersViewProps) {
  const [providers, setProviders] = useState<AuthProviderDescriptor[]>([])
  const [statuses, setStatuses] = useState<AuthProviderStatus[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [pList, sList] = await Promise.all([
        window.electronAPI.authListProviders(),
        window.electronAPI.authStatus(),
      ])
      setProviders(pList)
      setStatuses(sList)
    } catch (err) {
      log.warn('[ProvidersView] refresh failed', err)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    if (scopedProviderId) setDetailId(scopedProviderId)
  }, [scopedProviderId])

  const statusFor = useCallback(
    (id: string): AuthProviderStatus | undefined => statuses.find((s) => s.id === id),
    [statuses],
  )

  const grouped = useMemo(() => {
    const oauth: AuthProviderDescriptor[] = []
    const apiKey: AuthProviderDescriptor[] = []
    for (const p of providers) {
      if (p.kind === 'oauth') oauth.push(p)
      else if (p.kind === 'apiKey') apiKey.push(p)
    }
    return { oauth, apiKey }
  }, [providers])

  const selectedProvider = useMemo(
    () => (detailId ? providers.find((p) => p.id === detailId) ?? null : null),
    [providers, detailId],
  )

  const headerTitle = selectedProvider?.name ?? 'Providers'

  const handleBack = useCallback(() => {
    if (detailId) setDetailId(null)
    else onBack?.()
  }, [detailId, onBack])

  return (
    <div className="flex-1 flex flex-col bg-surface-4 text-primary min-h-0">
      {(!embedded || detailId) && (
        <div className="flex items-center gap-2 px-3 h-9 border-b border-subtle shrink-0">
          <button
            onClick={handleBack}
            className="p-1 -ml-1 rounded-md text-muted hover:text-primary hover:bg-white/5"
            title={detailId ? 'Back to providers' : 'Back to chat'}
            disabled={embedded && !detailId}
          >
            <ArrowLeft size={14} />
          </button>
          <div className="text-[12px] font-medium text-primary truncate flex-1 min-w-0">{headerTitle}</div>
          {selectedProvider && (
            <StatusPill status={statusFor(selectedProvider.id)} />
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {!selectedProvider ? (
          <div className="px-3 py-3 space-y-4">
            <DefaultModelSection statuses={statuses} />
            <Section label="Sign in">
              {grouped.oauth.map((p) => (
                <ProviderListRow
                  key={p.id}
                  name={p.name}
                  status={statusFor(p.id)}
                  onClick={() => setDetailId(p.id)}
                />
              ))}
            </Section>
            <Section label="API key">
              {grouped.apiKey.map((p) => (
                <ProviderListRow
                  key={p.id}
                  name={p.name}
                  status={statusFor(p.id)}
                  onClick={() => setDetailId(p.id)}
                />
              ))}
            </Section>
          </div>
        ) : (
          <div className="px-4 py-4">
            <ProviderDetail
              provider={selectedProvider}
              status={statusFor(selectedProvider.id)}
              onRefresh={refresh}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// List row + section
// -----------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="px-2 mb-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold">
        {label}
      </div>
      <div className="rounded-lg border border-white/5 bg-white/[0.02] overflow-hidden">
        {children}
      </div>
    </div>
  )
}

function ProviderListRow({
  name,
  status,
  onClick,
}: {
  name: string
  status?: AuthProviderStatus
  onClick: () => void
}) {
  const connected = !!status?.connected
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-2.5 py-2 text-left border-b border-white/5 last:border-0 hover:bg-white/[0.04]"
    >
      <span className="flex-1 truncate text-[12.5px] text-primary">{name}</span>
      {connected ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-agent-light/90">
          <CheckCircle size={10} weight="fill" /> Connected
        </span>
      ) : (
        <CircleDashed size={11} className="text-muted/60" />
      )}
      <CaretRight size={10} className="text-muted/60" />
    </button>
  )
}

function StatusPill({ status }: { status?: AuthProviderStatus }) {
  if (status?.connected) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-agent/15 text-agent-light">
        <CheckCircle size={10} weight="fill" />
        Connected
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-muted">
      <CircleDashed size={10} />
      Not connected
    </span>
  )
}

// -----------------------------------------------------------------------------
// Detail dispatcher
// -----------------------------------------------------------------------------

function ProviderDetail({
  provider,
  status,
  onRefresh,
}: {
  provider: AuthProviderDescriptor
  status?: AuthProviderStatus
  onRefresh: () => Promise<void>
}) {
  if (provider.kind === 'oauth') {
    return <OAuthForm provider={provider} status={status} onRefresh={onRefresh} />
  }
  return <ApiKeyForm provider={provider} status={status} onRefresh={onRefresh} />
}

// -----------------------------------------------------------------------------
// OAuth form
// -----------------------------------------------------------------------------

function OAuthForm({
  provider,
  status,
  onRefresh,
}: {
  provider: AuthProviderDescriptor
  status?: AuthProviderStatus
  onRefresh: () => Promise<void>
}) {
  const [phase, setPhase] = useState<OAuthFlowEvent | { type: 'idle' }>({ type: 'idle' })
  // pi-ai's anthropic/openai-codex flows emit `auth` and `manualCode` back-to-back.
  // We persist the auth URL separately so it stays visible (with Open/Copy buttons)
  // even after the phase advances to manualCode.
  const [authInfo, setAuthInfo] = useState<{ url: string; instructions?: string } | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (!window.electronAPI?.onAuthOAuthEvent) return
    const unsub = window.electronAPI.onAuthOAuthEvent((providerId, event) => {
      if (providerId !== provider.id) return
      setPhase(event)
      if (event.type === 'auth') setAuthInfo({ url: event.url, instructions: event.instructions })
      if (event.type === 'prompt' || event.type === 'manualCode') setPromptValue('')
      if (event.type === 'done' || event.type === 'error') setAuthInfo(null)
      if (event.type === 'done') onRefresh()
    })
    return unsub
  }, [provider.id, onRefresh])

  const handleStart = useCallback(async () => {
    setAuthInfo(null)
    setPhase({ type: 'progress', message: 'Opening browser…' })
    try {
      const res = await window.electronAPI.authOAuthStart(provider.id)
      if (!res.ok) {
        setPhase({ type: 'error', message: res.error })
      } else if (phaseRef.current.type === 'progress') {
        await onRefresh()
        setPhase({ type: 'done' })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setPhase({ type: 'error', message: msg })
    }
  }, [provider.id, onRefresh])

  const handlePromptSubmit = useCallback(async (promptId: string, value: string) => {
    setSubmitting(true)
    try {
      await window.electronAPI.authOAuthPromptReply(promptId, value)
      setPromptValue('')
    } catch (err) {
      log.warn('[OAuthForm] reply failed', err)
    } finally {
      setSubmitting(false)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.electronAPI.authDelete(provider.id)
      setPhase({ type: 'idle' })
      await onRefresh()
    } catch (err) {
      log.warn('[OAuthForm] disconnect failed', err)
    }
  }, [provider.id, onRefresh])

  return (
    <div className="space-y-4">
      {phase.type === 'idle' && (
        <div className="space-y-3">
          <button
            onClick={handleStart}
            className="w-full px-3 py-2.5 rounded-lg bg-agent hover:bg-agent-light text-white text-[13px] font-medium"
          >
            Sign in with {provider.name}
          </button>
          {status?.connected && (
            <button
              onClick={handleDisconnect}
              className="block text-[11px] text-muted hover:text-primary hover:underline"
            >
              Disconnect
            </button>
          )}
        </div>
      )}

      {authInfo && phase.type !== 'done' && phase.type !== 'error' && (
        <AuthUrlCard url={authInfo.url} instructions={authInfo.instructions} />
      )}

      {phase.type === 'deviceCode' && (
        <div className="space-y-3 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="text-[12px] text-primary">
            Enter this code in your browser at{' '}
            <a href={phase.verificationUri} target="_blank" rel="noreferrer" className="underline text-agent-light">
              {phase.verificationUri}
            </a>
            :
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-center font-mono text-[18px] tracking-[0.3em] py-2 rounded-md bg-black/30 text-primary">
              {phase.userCode}
            </code>
            <button
              onClick={() => { try { navigator.clipboard.writeText(phase.userCode) } catch { /* */ } }}
              className="p-2 rounded-md bg-white/5 hover:bg-white/10 text-primary"
              title="Copy code"
            >
              <Copy size={12} />
            </button>
          </div>
          {phase.expiresInSeconds != null && (
            <div className="text-[11px] text-muted">
              Code expires in ~{Math.round(phase.expiresInSeconds / 60)} min.
            </div>
          )}
        </div>
      )}

      {phase.type === 'progress' && (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Spinner size={14} className="animate-spin" />
          {phase.message}
        </div>
      )}

      {phase.type === 'prompt' && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <input
            type="text"
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePromptSubmit(phase.promptId, promptValue) }}
            placeholder={phase.placeholder ?? ''}
            className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60"
          />
          <div className="flex justify-end">
            <button
              disabled={submitting || (!phase.allowEmpty && !promptValue.trim())}
              onClick={() => handlePromptSubmit(phase.promptId, promptValue)}
              className="px-3 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px] font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      )}

      {phase.type === 'select' && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <div className="flex flex-col gap-1">
            {phase.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => handlePromptSubmit(phase.promptId, opt.id)}
                className="text-left px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-[12px] text-primary"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase.type === 'manualCode' && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="text-[12px] text-primary">
            Sign in completes automatically when the browser callback fires.
            If it doesn't, paste the code (or full redirect URL) here:
          </div>
          <input
            type="text"
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePromptSubmit(phase.promptId, promptValue) }}
            className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60"
          />
          <div className="flex justify-end">
            <button
              disabled={submitting || !promptValue.trim()}
              onClick={() => handlePromptSubmit(phase.promptId, promptValue)}
              className="px-3 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px] font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      )}

      {phase.type === 'done' && (
        <div className="flex items-center gap-2 text-[12px] text-agent-light">
          <CheckCircle size={14} weight="fill" /> Connected.
        </div>
      )}

      {phase.type === 'error' && (
        <div className="space-y-2 rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-primary text-[12px]"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  )
}

function AuthUrlCard({ url, instructions }: { url: string; instructions?: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-black/10 p-3">
      <div className="flex items-center gap-2 text-[12px] text-primary">
        <CloudArrowUp size={14} className="text-agent-light" />
        Browser opened for sign in.
      </div>
      {instructions && (
        <div className="text-[12px] text-muted whitespace-pre-wrap leading-relaxed">
          {instructions}
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary"
        >
          <ArrowSquareOut size={12} /> Open URL again
        </a>
        <button
          onClick={() => { try { navigator.clipboard.writeText(url) } catch { /* */ } }}
          className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary"
        >
          <Copy size={12} /> Copy URL
        </button>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// API key form
// -----------------------------------------------------------------------------

function ApiKeyForm({
  provider,
  status,
  onRefresh,
}: {
  provider: AuthProviderDescriptor
  status?: AuthProviderStatus
  onRefresh: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [reveal, setReveal] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const handleSave = useCallback(async () => {
    const key = value.trim()
    if (!key) { setError('Key is required'); return }
    setSaving(true); setError(null)
    try {
      await window.electronAPI.authSaveApiKey(provider.id, key)
      setValue('')
      setSavedAt(Date.now())
      await onRefresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [value, provider.id, onRefresh])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.electronAPI.authDelete(provider.id)
      setSavedAt(null)
      await onRefresh()
    } catch (err) {
      log.warn('[ApiKeyForm] disconnect failed', err)
    }
  }, [provider.id, onRefresh])

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <input
            type={reveal ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            autoComplete="off"
            spellCheck={false}
            placeholder={status?.connected ? '••••••••••••' : `Paste your ${provider.name} key`}
            className="flex-1 min-w-0 bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60 font-mono"
          />
          <button
            type="button"
            onClick={() => setReveal((r) => !r)}
            className="p-1.5 rounded-md text-muted hover:text-primary hover:bg-white/5"
            title={reveal ? 'Hide' : 'Show'}
          >
            {reveal ? <EyeSlash size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {error && <div className="text-[12px] text-primary">{error}</div>}
      {savedAt && !error && (
        <div className="text-[12px] text-agent-light flex items-center gap-1">
          <CheckCircle size={12} weight="fill" /> Saved.
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <button
          disabled={saving || !value.trim()}
          onClick={handleSave}
          className="px-3 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px] font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {status?.connected && (
          <button
            onClick={handleDisconnect}
            className="px-3 py-1.5 rounded-md text-muted hover:text-primary hover:bg-white/5 text-[12px]"
          >
            Disconnect
          </button>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Default model section — pins the model used for every new chat. Lives here
// because providers/auth gate which models can be picked, so the lists move
// together.
// -----------------------------------------------------------------------------

function DefaultModelSection({ statuses }: { statuses: AuthProviderStatus[] }) {
  const [models, setModels] = useState<Array<{ provider: string; model: string; label?: string }>>([])
  const [current, setCurrent] = useState<AgentModelRef | null>(() => loadDefaultModel())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const list = await window.electronAPI.authListModels()
        if (!cancelled) setModels(list)
      } catch (err) {
        log.warn('[DefaultModelSection] listModels failed', err)
      }
    })()
    return () => { cancelled = true }
  }, [statuses])

  const handlePick = useCallback((m: { provider: string; model: string } | null) => {
    if (!m) {
      saveDefaultModel(null)
      setCurrent(null)
    } else {
      const next: AgentModelRef = { provider: m.provider, model: m.model }
      saveDefaultModel(next)
      setCurrent(next)
    }
    setOpen(false)
  }, [])

  return (
    <div className="space-y-1.5">
      <div className="text-[10.5px] uppercase tracking-wider text-muted/70 font-semibold px-0.5">
        Default model
      </div>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-white/[0.04] border border-white/10 text-[12.5px] text-primary hover:bg-white/[0.06] focus:outline-none focus:border-agent-light/50"
        >
          <Sparkle size={12} weight="fill" className="text-agent-light shrink-0" />
          <span className="truncate flex-1 text-left">
            {current
              ? (models.find((m) => m.provider === current.provider && m.model === current.model)?.label ?? current.model)
              : 'First available'}
          </span>
          <CaretDown size={10} className="text-muted shrink-0" />
        </button>
        {open && (
          <DefaultModelPicker
            models={models}
            selected={current}
            onPick={handlePick}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  )
}

function DefaultModelPicker({
  models,
  selected,
  onPick,
  onClose,
}: {
  models: Array<{ provider: string; model: string; label?: string }>
  selected: AgentModelRef | null
  onPick: (m: { provider: string; model: string } | null) => void
  onClose: () => void
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
      className="absolute top-full left-0 mt-1 w-full max-h-[320px] flex flex-col rounded-lg border border-white/10 bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_rgba(0,0,0,0.45)] z-20"
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
        <button
          onClick={() => onPick(null)}
          className={`w-full text-left px-3 py-1.5 text-[12px] flex items-center gap-2 ${
            !selected ? 'bg-white/10 text-primary' : 'text-muted hover:bg-white/5'
          }`}
        >
          <span className="truncate flex-1">First available</span>
          {!selected && <CheckCircle size={10} weight="fill" className="text-agent-light" />}
        </button>
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
    </div>
  )
}

