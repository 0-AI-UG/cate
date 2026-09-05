import { LoadingState, Spinner } from '../ui/Spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowBendDownLeft, ArrowSquareOut, CaretDown, CaretUp, Check, CheckCircle, Copy, SignIn } from '@phosphor-icons/react'
import { btn, inputCls, Modal } from '../ui/Modal'
import { useAppStore } from '../stores/appStore'
import { SearchableBlock, SecondaryButton } from './SettingsComponents'
import { AgentProviderConfiguration } from './AgentProviderConfiguration'
import { AGENT_PROVIDER_LOGINS, type AgentProviderLogin } from './providerAuthentication'
import type { AgentProviderAuthSession, AgentProviderStatus } from '../../shared/t3Agent'

export function AgentSettings() {
  const [authProvider, setAuthProvider] = useState<AgentProviderLogin | null>(null)
  const [authSession, setAuthSession] = useState<AgentProviderAuthSession | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStarting, setAuthStarting] = useState(false)
  const [openCodeProvider, setOpenCodeProvider] = useState('')
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false)
  const [providerStatuses, setProviderStatuses] = useState<AgentProviderStatus[]>([])
  const [providerStatusesLoading, setProviderStatusesLoading] = useState(false)
  const openedAuthUrlRef = useRef<string | null>(null)
  const workspace = useAppStore((state) => (
    state.workspaces.find((item) => item.id === state.selectedWorkspaceId)
  ))
  const workspaceId = workspace?.id ?? ''
  const cwd = workspace?.rootPath ?? ''

  const refreshProviderStatuses = useCallback(async (): Promise<void> => {
    if (!workspaceId || !cwd) return
    setProviderStatusesLoading(true)
    try {
      const result = await window.electronAPI.agentProviderStatusGet({ workspaceId, cwd })
      if (!('error' in result)) setProviderStatuses(result)
    } finally {
      setProviderStatusesLoading(false)
    }
  }, [cwd, workspaceId])

  useEffect(() => {
    if (!workspaceId || !cwd) return
    void refreshProviderStatuses()
    const retry = window.setTimeout(() => void refreshProviderStatuses(), 1_500)
    return () => window.clearTimeout(retry)
  }, [cwd, refreshProviderStatuses, workspaceId])

  const startProviderLogin = async (
    provider: AgentProviderLogin,
    openCodeTarget?: string,
  ): Promise<void> => {
    if (!workspaceId || !cwd) return
    setAuthProvider(provider)
    setAuthSession(null)
    setAuthError(null)
    setAuthStarting(true)
    setCopiedDeviceCode(false)
    openedAuthUrlRef.current = null
    try {
      const result = await window.electronAPI.agentProviderAuthStart({
        workspaceId,
        cwd,
        providerId: provider.id,
        ...(provider.id === 'opencode' && openCodeTarget?.trim()
          ? { provider: openCodeTarget.trim() }
          : {}),
      })
      if ('error' in result) setAuthError(result.error)
      else setAuthSession(result)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Sign-in could not be started.')
    } finally {
      setAuthStarting(false)
    }
  }

  const openProviderLogin = (provider: AgentProviderLogin): void => {
    setAuthProvider(provider)
    setAuthSession(null)
    setAuthError(null)
    setOpenCodeProvider('')
    setCopiedDeviceCode(false)
    openedAuthUrlRef.current = null
    if (provider.id !== 'opencode') void startProviderLogin(provider)
  }

  const closeProviderLogin = (): void => {
    if (authSession?.phase === 'running') {
      void window.electronAPI.agentProviderAuthCancel({ id: authSession.id })
    }
    setAuthProvider(null)
    setAuthSession(null)
    setAuthError(null)
  }

  const sendProviderLoginInput = (data: string): void => {
    if (authSession?.phase !== 'running') return
    void window.electronAPI.agentProviderAuthWrite({ id: authSession.id, data })
  }

  useEffect(() => {
    if (authSession?.phase !== 'running') return
    let cancelled = false
    const poll = window.setInterval(() => {
      void window.electronAPI.agentProviderAuthGet({ id: authSession.id }).then((result) => {
        if (cancelled) return
        if ('error' in result) setAuthError(result.error)
        else setAuthSession(result)
      })
    }, 400)
    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [authSession?.id, authSession?.phase])

  useEffect(() => {
    const url = authSession?.url
    if (!url || openedAuthUrlRef.current === url) return
    openedAuthUrlRef.current = url
    window.electronAPI.openExternalUrl(url)
  }, [authSession?.url])


  useEffect(() => {
    if (authSession?.phase !== 'succeeded') return
    setProviderStatuses((current) => [
      ...current.filter((status) => status.providerId !== authSession.providerId),
      { providerId: authSession.providerId, state: 'authenticated' },
    ])
    const refresh = window.setTimeout(() => void refreshProviderStatuses(), 1_500)
    return () => window.clearTimeout(refresh)
  }, [authSession?.phase, authSession?.providerId, refreshProviderStatuses])

  return (
    <SearchableBlock keywords="t3 code agent providers models sign in authentication codex claude cursor grok opencode advanced display name accent color binary path home launch arguments custom models environment variables server password endpoint auto-compact updates legacy token streaming settle chats merge refresh interval generated titles">
      <div className="flex flex-col gap-4">
        <AgentProviderConfiguration workspaceId={workspaceId} cwd={cwd} onChanged={refreshProviderStatuses} authentication={(driver) => (
          <div>
            {AGENT_PROVIDER_LOGINS.filter((provider) => provider.id === (driver === 'claudeAgent' ? 'claude' : driver)).map((provider) => {
                const status = providerStatuses.find((item) => item.providerId === provider.id)
                const connected = status?.state === 'authenticated'
                const statusLabel = connected
                  ? status.label ? `Connected · ${status.label}` : 'Connected'
                  : status?.state === 'unauthenticated'
                    ? 'Not signed in'
                    : status?.state === 'unavailable'
                      ? 'CLI not found'
                      : status?.state === 'disabled'
                        ? 'Disabled in provider configuration'
                        : providerStatusesLoading
                          ? <Spinner size={13} label="Checking provider status" />
                          : 'Status unavailable'
                const versionLabel = status?.version ? `v${status.version.replace(/^v/, '')}` : null
                return (
                  <div
                    key={provider.id}
                    data-agent-provider={provider.id}
                    data-agent-provider-state={status?.state ?? 'unknown'}
                    className="flex flex-wrap items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <h3 className="text-sm font-medium text-primary">{provider.name} account</h3>
                      <p className="mt-0.5 text-xs text-muted">{provider.description}</p>
                      <p className={`mt-1 flex items-center gap-1 text-xs ${connected ? 'text-green-400' : 'text-muted'}`}>
                        {connected && <CheckCircle size={13} weight="fill" />}
                        {statusLabel}
                        {versionLabel && <span className="text-muted">· {versionLabel}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <SecondaryButton
                        onClick={() => openProviderLogin(provider)}
                        disabled={!workspaceId || !cwd}
                        title={!workspaceId || !cwd ? 'Open a workspace first' : `Sign in to ${provider.name}`}
                      >
                        <SignIn size={12} />
                        {connected ? 'Sign in again' : 'Sign in'}
                      </SecondaryButton>
                    </div>
                  </div>
                )
            })}
          </div>
        )} />

        <p className="text-xs text-muted">
          Conversations run in{' '}
          <button
            type="button"
            onClick={() => window.electronAPI.openExternalUrl('https://github.com/pingdotgg/t3code')}
            className="inline-flex items-center gap-1 text-focus-blue hover:underline"
          >
            T3 Code
            <ArrowSquareOut size={11} />
          </button>
          . Cate provides the project, worktree, panel, browser, and diff experience around it.
        </p>
      </div>

      {authProvider && (
        <Modal
          onClose={closeProviderLogin}
          title={`Sign in to ${authProvider.name}`}
          icon={<SignIn size={17} />}
          width={560}
          zClassName="z-[100003]"
        >
          <div className="flex flex-col gap-4 p-5">
            {authProvider.id === 'opencode' && !authSession && !authStarting && !authError && (
              <div className="flex flex-col gap-2">
                <label htmlFor="opencode-provider" className="text-sm text-primary">
                  OpenCode provider
                </label>
                <p className="text-xs text-muted">
                  Enter the provider ID or name you want OpenCode to authenticate.
                </p>
                <input
                  id="opencode-provider"
                  autoFocus
                  value={openCodeProvider}
                  onChange={(event) => setOpenCodeProvider(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && openCodeProvider.trim()) {
                      void startProviderLogin(authProvider, openCodeProvider)
                    }
                  }}
                  placeholder="For example: anthropic or openai"
                  className={inputCls}
                />
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    className={btn.primary}
                    disabled={!openCodeProvider.trim()}
                    onClick={() => void startProviderLogin(authProvider, openCodeProvider)}
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {authStarting && (
              <LoadingState label="Starting official sign-in…" className="py-8 text-sm" />
            )}

            {authError && (
              <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {authError}
              </div>
            )}

            {authSession && (
              <>
                <div className="flex items-center gap-2 text-sm text-primary">
                  {authSession.phase === 'running' && <Spinner size={16} label="Waiting for sign-in" />}
                  <span>{authSession.message ?? (authSession.phase === 'running' ? 'Waiting for sign-in…' : 'Sign-in finished.')}</span>
                </div>
                {authSession.code && (
                  <div className="rounded-lg border-2 border-focus-blue bg-focus-blue/10 px-5 py-5 text-center shadow-[0_0_24px_rgba(59,130,246,0.12)]">
                    <p className="text-sm font-medium text-primary">
                      Enter this code on the sign-in page
                    </p>
                    <code className="mt-3 block select-all font-mono text-2xl font-semibold tracking-[0.18em] text-focus-blue">
                      {authSession.code}
                    </code>
                    <button
                      type="button"
                      className={`${btn.primary} mt-4`}
                      onClick={() => {
                        void window.electronAPI.terminalClipboardWrite(authSession.code!)
                        setCopiedDeviceCode(true)
                      }}
                    >
                      {copiedDeviceCode ? <Check size={14} /> : <Copy size={14} />}
                      {copiedDeviceCode ? 'Copied' : 'Copy code'}
                    </button>
                  </div>
                )}
                <pre className="max-h-64 min-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border border-subtle bg-surface-0 p-3 font-mono text-xs leading-5 text-secondary select-text">
                  {authSession.output.trim() || 'Waiting for the provider to begin the login flow…'}
                </pre>
                {authSession.phase === 'running' && (
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs text-muted">
                      If the provider shows a selection, use these controls to answer it.
                    </p>
                    <div className="flex items-center gap-1">
                      <button type="button" className={btn.secondary} onClick={() => sendProviderLoginInput('\u001b[A')} title="Previous option">
                        <CaretUp size={13} />
                      </button>
                      <button type="button" className={btn.secondary} onClick={() => sendProviderLoginInput('\u001b[B')} title="Next option">
                        <CaretDown size={13} />
                      </button>
                      <button type="button" className={btn.secondary} onClick={() => sendProviderLoginInput('\r')}>
                        <ArrowBendDownLeft size={13} />
                        Select
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  {authSession.url && (
                    <button type="button" className={btn.secondary} onClick={() => window.electronAPI.openExternalUrl(authSession.url!)}>
                      <ArrowSquareOut size={13} />
                      Open sign-in page
                    </button>
                  )}
                  <button type="button" className={authSession.phase === 'running' ? btn.secondary : btn.primary} onClick={closeProviderLogin}>
                    {authSession.phase === 'running' ? 'Cancel' : 'Done'}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </SearchableBlock>
  )
}
