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
          <div className="text-[12px] font-medium text-primary truncate">{headerTitle}</div>
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
        <span className="inline-flex items-center gap-1 text-[10px] text-violet-300/90">
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
      <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300">
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
  const [promptValue, setPromptValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const phaseRef = useRef(phase)
  phaseRef.current = phase

  useEffect(() => {
    if (!window.electronAPI?.onAuthOAuthEvent) return
    const unsub = window.electronAPI.onAuthOAuthEvent((providerId, event) => {
      if (providerId !== provider.id) return
      setPhase(event)
      if (event.type === 'prompt' || event.type === 'manualCode') setPromptValue('')
      if (event.type === 'done') onRefresh()
    })
    return unsub
  }, [provider.id, onRefresh])

  const handleStart = useCallback(async () => {
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
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium text-primary truncate min-w-0">{provider.name}</div>
        <StatusPill status={status} />
      </div>

      {phase.type === 'idle' && (
        <div className="space-y-3">
          <button
            onClick={handleStart}
            className="w-full px-3 py-2.5 rounded-lg bg-violet-500 hover:bg-violet-400 text-white text-[13px] font-medium"
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

      {phase.type === 'auth' && (
        <div className="space-y-3 rounded-lg border border-white/10 bg-black/10 p-3">
          <div className="flex items-center gap-2 text-[12px] text-primary">
            <CloudArrowUp size={14} className="text-violet-300" />
            Opening browser to sign in…
          </div>
          {phase.instructions && (
            <div className="text-[12px] text-muted whitespace-pre-wrap leading-relaxed">
              {phase.instructions}
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={phase.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary"
            >
              <ArrowSquareOut size={12} /> Open URL
            </a>
            <button
              onClick={() => { try { navigator.clipboard.writeText(phase.url) } catch { /* */ } }}
              className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-primary"
            >
              <Copy size={12} /> Copy URL
            </button>
          </div>
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
            className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-violet-500/60"
          />
          <div className="flex justify-end">
            <button
              disabled={submitting || (!phase.allowEmpty && !promptValue.trim())}
              onClick={() => handlePromptSubmit(phase.promptId, promptValue)}
              className="px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white text-[12px] font-medium"
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
          <div className="text-[12px] text-primary">Paste the code from the browser:</div>
          <input
            type="text"
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePromptSubmit(phase.promptId, promptValue) }}
            className="w-full bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-violet-500/60"
          />
          <div className="flex justify-end">
            <button
              disabled={submitting || !promptValue.trim()}
              onClick={() => handlePromptSubmit(phase.promptId, promptValue)}
              className="px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white text-[12px] font-medium"
            >
              Submit
            </button>
          </div>
        </div>
      )}

      {phase.type === 'done' && (
        <div className="flex items-center gap-2 text-[12px] text-violet-300">
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
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium text-primary truncate min-w-0">{provider.name}</div>
        <StatusPill status={status} />
      </div>

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
            className="flex-1 min-w-0 bg-surface-3 border border-white/10 rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-violet-500/60 font-mono"
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
        <div className="text-[12px] text-violet-300 flex items-center gap-1">
          <CheckCircle size={12} weight="fill" /> Saved.
        </div>
      )}

      <div className="flex items-center gap-2 pt-2">
        <button
          disabled={saving || !value.trim()}
          onClick={handleSave}
          className="px-3 py-1.5 rounded-md bg-violet-500 hover:bg-violet-400 disabled:opacity-40 text-white text-[12px] font-medium"
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

  const handleChange = useCallback((value: string) => {
    if (!value) {
      saveDefaultModel(null)
      setCurrent(null)
      return
    }
    const [provider, ...rest] = value.split('::')
    const model = rest.join('::')
    if (!provider || !model) return
    const next: AgentModelRef = { provider, model }
    saveDefaultModel(next)
    setCurrent(next)
  }, [])

  const selectedKey = current ? `${current.provider}::${current.model}` : ''
  const currentMissing = !!current && !models.some(
    (m) => m.provider === current.provider && m.model === current.model,
  )

  return (
    <Section label="Default model">
      <div className="px-2.5 py-2.5 space-y-1.5">
        <select
          value={selectedKey}
          onChange={(e) => handleChange(e.target.value)}
          className="w-full bg-white/[0.04] border border-white/10 rounded-md px-2 py-1.5 text-[12.5px] text-primary focus:outline-none focus:border-violet-400/50"
        >
          <option value="">No default — first available</option>
          {currentMissing && current && (
            <option value={selectedKey}>
              {current.model} ({current.provider} — disconnected)
            </option>
          )}
          {groupByProvider(models).map(([provider, items]) => (
            <optgroup key={provider} label={provider}>
              {items.map((m) => (
                <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                  {m.label ?? m.model}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="text-[10.5px] text-muted/70">
          Applied to every new chat. Existing chats keep the model they were last using.
        </div>
      </div>
    </Section>
  )
}

function groupByProvider(
  models: Array<{ provider: string; model: string; label?: string }>,
): Array<[string, Array<{ provider: string; model: string; label?: string }>]> {
  const map = new Map<string, Array<{ provider: string; model: string; label?: string }>>()
  for (const m of models) {
    const bucket = map.get(m.provider) ?? []
    bucket.push(m)
    map.set(m.provider, bucket)
  }
  return Array.from(map.entries())
}
