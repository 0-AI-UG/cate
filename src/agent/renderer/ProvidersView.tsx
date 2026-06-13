// =============================================================================
// ProvidersView — in-panel UI for managing pi agent provider authentication.
//
// Accordion: the full provider list is always visible; clicking a row expands
// its sign-in / API-key form inline beneath it (at most one open at a time).
// When embedded in Settings the parent owns the surrounding chrome.
//
// Built-in providers sign in / store an API key. A final "Custom OpenAI
// endpoint" section lets the user point the agent at any OpenAI-compatible
// server (Ollama, LM Studio, vLLM, a proxy); it is persisted to pi's
// models.json via agentCustomModels* IPC.
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
} from '@phosphor-icons/react'
import { CateLogo } from '../../renderer/ui/CateLogo'
import { ModelPickerDropdown } from './ModelPicker'
import log from '../../renderer/lib/logger'
import { errorMessage as toErrorMessage } from '../../renderer/lib/errorMessage'
import { Tooltip } from '../../renderer/ui/Tooltip'
import type {
  AgentModelRef,
  AuthProviderDescriptor,
  AuthProviderStatus,
  CustomOpenAIProvider,
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
  // Selectable models for the default-model picker — derived from the connected
  // providers in auth.json, so it works here without an agent session running.
  const [models, setModels] = useState<Array<{ provider: string; model: string; label?: string }>>([])
  // Accordion: at most one provider expanded at a time. Keyed by `${kind}-${id}`
  // because the same provider id can appear as both an OAuth and an API-key entry.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [pList, sList, mList] = await Promise.all([
        window.electronAPI.authListProviders(),
        window.electronAPI.authStatus(),
        window.electronAPI.agentListModels(),
      ])
      setProviders(pList)
      setStatuses(sList)
      setModels(mList.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
    } catch (err) {
      log.warn('[ProvidersView] refresh failed', err)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Credentials can change in another window (or via a background token
  // refresh). Re-pull provider status + the model list when the main process
  // broadcasts a change so neither the Connected/Disconnected state nor the
  // default-model picker goes stale.
  useEffect(() => {
    if (!window.electronAPI?.onAuthChanged) return
    const unsub = window.electronAPI.onAuthChanged(() => { void refresh() })
    return unsub
  }, [refresh])

  useEffect(() => {
    if (!scopedProviderId) return
    // Prefer the OAuth entry when a provider id exists in both groups.
    const match =
      providers.find((p) => p.kind === 'oauth' && p.id === scopedProviderId) ??
      providers.find((p) => p.id === scopedProviderId)
    if (match) setExpandedKey(`${match.kind}-${match.id}`)
  }, [scopedProviderId, providers])

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

  const toggle = useCallback((key: string) => {
    setExpandedKey((prev) => (prev === key ? null : key))
  }, [])

  const body = (
    <>
      <DefaultModelSection models={models} />
      <Section label="Sign in">
        {grouped.oauth.map((p) => {
          const key = `oauth-${p.id}`
          return (
            <ProviderAccordionRow
              key={key}
              provider={p}
              status={statusFor(p.id)}
              expanded={expandedKey === key}
              onToggle={() => toggle(key)}
              onRefresh={refresh}
            />
          )
        })}
      </Section>
      <Section label="API key">
        {grouped.apiKey.map((p) => {
          const key = `apiKey-${p.id}`
          return (
            <ProviderAccordionRow
              key={key}
              provider={p}
              status={statusFor(p.id)}
              expanded={expandedKey === key}
              onToggle={() => toggle(key)}
              onRefresh={refresh}
            />
          )
        })}
      </Section>
      <Section label="Custom">
        <CustomOpenAIRow
          expanded={expandedKey === 'custom-openai'}
          onToggle={() => toggle('custom-openai')}
        />
      </Section>
    </>
  )

  // Embedded in the main Settings window: render as a plain block so it inherits
  // the section column's width + padding and the page's single scroll — no extra
  // horizontal inset or nested scroll area like the in-panel (agent) chrome has.
  if (embedded) {
    return <div className="space-y-4 text-primary">{body}</div>
  }

  return (
    <div className="flex-1 flex flex-col text-primary min-h-0">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-subtle shrink-0">
        <Tooltip label="Back to chat">
          <button
            onClick={() => onBack?.()}
            className="p-1 -ml-1 rounded-md text-muted hover:text-primary hover:bg-hover"
            aria-label="Back to chat"
          >
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <div className="text-[12px] font-medium text-primary truncate flex-1 min-w-0">Providers</div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="px-3 py-3 space-y-4">{body}</div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Custom OpenAI-compatible endpoint — one user-defined provider written to pi's
// models.json. Connects the agent to Ollama, LM Studio, vLLM, a proxy, etc.
// -----------------------------------------------------------------------------

function CustomOpenAIRow({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: () => void
}) {
  const [cfg, setCfg] = useState<CustomOpenAIProvider | null>(null)

  useEffect(() => {
    window.electronAPI.agentCustomModelsGet()
      .then((c) => setCfg(c))
      .catch((err) => log.warn('[CustomOpenAIRow] load failed', err))
  }, [])

  const configured = !!cfg && !!cfg.baseUrl && cfg.models.length > 0
  return (
    <div className="border-b border-subtle last:border-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-hover"
      >
        <span className="flex-1 truncate text-[12.5px] text-primary">Custom OpenAI endpoint</span>
        {configured ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-agent-light/90">
            <CheckCircle size={10} weight="fill" /> Configured
          </span>
        ) : (
          <CircleDashed size={11} className="text-muted/60" />
        )}
        {expanded
          ? <CaretDown size={10} className="text-muted/60" />
          : <CaretRight size={10} className="text-muted/60" />}
      </button>
      {expanded && (
        <div className="p-2.5 border-t border-subtle bg-surface-0">
          <CustomOpenAIForm cfg={cfg} onSaved={setCfg} />
        </div>
      )}
    </div>
  )
}

function CustomOpenAIForm({
  cfg,
  onSaved,
}: {
  cfg: CustomOpenAIProvider | null
  onSaved: (cfg: CustomOpenAIProvider | null) => void
}) {
  const [baseUrl, setBaseUrl] = useState(cfg?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(cfg?.apiKey ?? '')
  const [models, setModels] = useState((cfg?.models ?? []).join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const handleSave = useCallback(async () => {
    const url = baseUrl.trim()
    const modelIds = models.split(',').map((m) => m.trim()).filter(Boolean)
    if (!url) { setError('Base URL is required'); return }
    if (modelIds.length === 0) { setError('Add at least one model id'); return }
    setSaving(true); setError(null)
    const next: CustomOpenAIProvider = { baseUrl: url, apiKey: apiKey.trim(), models: modelIds }
    try {
      await window.electronAPI.agentCustomModelsSave(next)
      onSaved(next)
      setSavedAt(Date.now())
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [baseUrl, apiKey, models, onSaved])

  const handleRemove = useCallback(async () => {
    setSaving(true); setError(null)
    try {
      await window.electronAPI.agentCustomModelsSave(null)
      onSaved(null)
      setBaseUrl(''); setApiKey(''); setModels(''); setSavedAt(null)
    } catch (err) {
      setError(toErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [onSaved])

  const configured = !!cfg && !!cfg.baseUrl && cfg.models.length > 0
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="Base URL (e.g. http://localhost:11434/v1)"
        className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60 font-mono"
      />
      <SecretInput
        value={apiKey}
        onChange={setApiKey}
        placeholder="API key (optional for local servers)"
      />
      <input
        type="text"
        value={models}
        onChange={(e) => setModels(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        placeholder="Model ids, comma-separated (e.g. llama3.1:8b)"
        className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60 font-mono"
      />
      <div className="text-[11px] text-muted leading-relaxed">
        Any OpenAI-compatible server.
      </div>

      <div className="flex items-center gap-2">
        <button
          disabled={saving}
          onClick={handleSave}
          className="shrink-0 px-3 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px] font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {configured && (
          <button
            disabled={saving}
            onClick={handleRemove}
            className="text-[11px] text-muted hover:text-danger"
          >
            Remove
          </button>
        )}
      </div>

      <SaveFeedback error={error} savedAt={savedAt} />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Shared form bits — password input with a reveal toggle, and the save-status
// footer (error / "Saved.") used by both the API-key and custom-endpoint forms.
// -----------------------------------------------------------------------------

function SecretInput({
  value,
  onChange,
  placeholder,
  onKeyDown,
  className = 'relative',
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  className?: string
}) {
  const [reveal, setReveal] = useState(false)
  return (
    <div className={className}>
      <input
        type={reveal ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        className="w-full bg-surface-3 border border-strong rounded-md pl-2 pr-8 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60 font-mono"
      />
      <Tooltip label={reveal ? 'Hide' : 'Show'}>
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded text-muted hover:text-primary"
          aria-label={reveal ? 'Hide' : 'Show'}
        >
          {reveal ? <EyeSlash size={14} /> : <Eye size={14} />}
        </button>
      </Tooltip>
    </div>
  )
}

function SaveFeedback({ error, savedAt }: { error: string | null; savedAt: number | null }) {
  return (
    <>
      {error && <div className="text-[11px] text-danger">{error}</div>}
      {savedAt && !error && (
        <div className="flex items-center gap-1 text-[11px] text-agent-light">
          <CheckCircle size={12} weight="fill" /> Saved.
        </div>
      )}
    </>
  )
}

// -----------------------------------------------------------------------------
// List row + section
// -----------------------------------------------------------------------------

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted/70 font-semibold">
        {label}
      </div>
      <div className="rounded-lg border border-subtle bg-white/[0.02] overflow-hidden">
        {children}
      </div>
    </div>
  )
}

function ProviderAccordionRow({
  provider,
  status,
  expanded,
  onToggle,
  onRefresh,
}: {
  provider: AuthProviderDescriptor
  status?: AuthProviderStatus
  expanded: boolean
  onToggle: () => void
  onRefresh: () => Promise<void>
}) {
  const connected = !!status?.connected
  return (
    <div className="border-b border-subtle last:border-0">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-hover"
      >
        <span className="flex-1 truncate text-[12.5px] text-primary">{provider.name}</span>
        {connected ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-agent-light/90">
            <CheckCircle size={10} weight="fill" /> Connected
          </span>
        ) : (
          <CircleDashed size={11} className="text-muted/60" />
        )}
        {expanded
          ? <CaretDown size={10} className="text-muted/60" />
          : <CaretRight size={10} className="text-muted/60" />}
      </button>
      {expanded && (
        <div className="p-2.5 border-t border-subtle bg-surface-0">
          <ProviderDetail provider={provider} status={status} onRefresh={onRefresh} />
        </div>
      )}
    </div>
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
      const msg = toErrorMessage(err)
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
    <div className="space-y-3">
      {phase.type === 'idle' && !status?.connected && (
        <button
          onClick={handleStart}
          className="w-full px-3 py-2 rounded-md bg-agent hover:bg-agent-light text-white text-[12px] font-medium"
        >
          Sign in with {provider.name}
        </button>
      )}
      {phase.type === 'idle' && status?.connected && (
        <div className="flex items-center gap-2">
          <button
            onClick={handleStart}
            className="flex-1 px-3 py-1.5 rounded-md bg-hover hover:bg-hover-strong text-primary text-[12px]"
          >
            Re-authenticate
          </button>
          <button
            onClick={handleDisconnect}
            className="shrink-0 px-3 py-1.5 rounded-md bg-hover hover:bg-hover-strong text-[12px] text-danger hover:text-danger"
          >
            Disconnect
          </button>
        </div>
      )}

      {authInfo && phase.type !== 'done' && phase.type !== 'error' && (
        <AuthUrlCard url={authInfo.url} instructions={authInfo.instructions} />
      )}

      {phase.type === 'deviceCode' && (
        <div className="space-y-3 rounded-md border border-strong bg-hover p-2.5">
          <div className="text-[12px] text-primary">
            Enter this code in your browser at{' '}
            <a href={phase.verificationUri} target="_blank" rel="noreferrer" className="underline text-agent-light">
              {phase.verificationUri}
            </a>
            :
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-center font-mono text-[18px] tracking-[0.3em] py-2 rounded-md bg-surface-0 text-primary">
              {phase.userCode}
            </code>
            <Tooltip label="Copy code">
              <button
                onClick={() => { try { navigator.clipboard.writeText(phase.userCode) } catch { /* */ } }}
                className="p-2 rounded-md bg-hover hover:bg-hover-strong text-primary"
                aria-label="Copy code"
              >
                <Copy size={12} />
              </button>
            </Tooltip>
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
        <div className="space-y-2 rounded-md border border-strong bg-hover p-2.5">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <input
            type="text"
            autoFocus
            value={promptValue}
            onChange={(e) => setPromptValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePromptSubmit(phase.promptId, promptValue) }}
            placeholder={phase.placeholder ?? ''}
            className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60"
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
        <div className="space-y-2 rounded-md border border-strong bg-hover p-2.5">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <div className="flex flex-col gap-1">
            {phase.options.map((opt) => (
              <button
                key={opt.id}
                onClick={() => handlePromptSubmit(phase.promptId, opt.id)}
                className="text-left px-2 py-1.5 rounded-md bg-hover hover:bg-hover-strong text-[12px] text-primary"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {phase.type === 'manualCode' && (
        <div className="space-y-2 rounded-md border border-strong bg-hover p-2.5">
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
            className="w-full bg-surface-3 border border-strong rounded-md px-2 py-1.5 text-[13px] text-primary outline-none focus:border-agent/60"
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
        <div className="space-y-2 rounded-md border border-strong bg-hover p-2.5">
          <div className="text-[12px] text-primary">{phase.message}</div>
          <button
            onClick={handleStart}
            className="px-3 py-1.5 rounded-md bg-hover-strong hover:bg-hover-strong text-primary text-[12px]"
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
    <div className="space-y-3 rounded-md border border-strong bg-hover p-2.5">
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
          className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary"
        >
          <ArrowSquareOut size={12} /> Open URL again
        </a>
        <button
          onClick={() => { try { navigator.clipboard.writeText(url) } catch { /* */ } }}
          className="inline-flex items-center gap-1 text-[12px] px-2 py-1 rounded-md bg-hover hover:bg-hover-strong text-primary"
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
      setError(toErrorMessage(err))
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
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <SecretInput
          value={value}
          onChange={setValue}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          placeholder={status?.connected ? '••••••••••••' : `Paste your ${provider.name} key`}
          className="relative flex-1 min-w-0"
        />
        <button
          disabled={saving || !value.trim()}
          onClick={handleSave}
          className="shrink-0 px-3 py-1.5 rounded-md bg-agent hover:bg-agent-light disabled:opacity-40 text-white text-[12px] font-medium"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <SaveFeedback error={error} savedAt={savedAt} />
      {status?.connected && (
        <button
          onClick={handleDisconnect}
          className="text-[11px] text-muted hover:text-danger"
        >
          Disconnect
        </button>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Default model section — pins the model used for every new chat. Lives here
// because providers/auth gate which models can be picked, so the lists move
// together.
// -----------------------------------------------------------------------------

function DefaultModelSection({ models }: { models: Array<{ provider: string; model: string; label?: string }> }) {
  const [current, setCurrent] = useState<AgentModelRef | null>(() => loadDefaultModel())
  const [open, setOpen] = useState(false)

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
      <div className="text-[10.5px] uppercase tracking-wider text-muted/70 font-semibold">
        Default model
      </div>
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-hover border border-strong text-[12.5px] text-primary hover:bg-hover-strong focus:outline-none focus:border-agent-light/50"
        >
          <CateLogo size={12} className="text-agent-light shrink-0" />
          <span className="truncate flex-1 text-left">
            {current
              ? (models.find((m) => m.provider === current.provider && m.model === current.model)?.label ?? current.model)
              : 'First available'}
          </span>
          <CaretDown size={10} className="text-muted shrink-0" />
        </button>
        {open && (
          <ModelPickerDropdown
            models={models}
            selected={current}
            onPick={handlePick}
            onClose={() => setOpen(false)}
            className="w-full max-h-[320px]"
            allowNone
            noneLabel="First available"
          />
        )}
      </div>
    </div>
  )
}

