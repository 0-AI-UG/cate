// Provider accounts for T3 chats: each provider's sign-in state, the official
// CLI sign-in flow (run on the runtime, answered here), and T3's provider
// configuration. Over the `t3` capability of the open workspace.

import { useCallback, useEffect, useRef, useState } from 'react'
import { CornerDownLeft as ArrowBendDownLeft, SquareArrowOutUpRight as ArrowSquareOut, ChevronDown as CaretDown, ChevronUp as CaretUp, Check, CircleCheck as CheckCircle, Copy, LogIn as SignIn } from 'lucide-react'
import type { CapabilityProxy } from '@kernel/rpc/contract'
import { isLoopbackUrl } from '@runtime/tunnel/contract'
import { LoadingState, Spinner, Modal, btn, inputCls, SecondaryButton } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { providerAuthUsesLoopback, type T3ProviderAuthSession, type T3ProviderId, type T3ProviderStatus, type t3Capability } from '@services/t3/contract'
import { T3ProviderConfiguration } from './T3ProviderConfiguration'
import { T3_PROVIDER_LOGINS, type T3ProviderLogin } from './providers'

export type T3ProvidersProxy = Pick<CapabilityProxy<typeof t3Capability>,
  'providerSettings' | 'providerStatuses' | 'providerAuthStart' | 'providerAuthGet' | 'providerAuthWrite' | 'providerAuthCancel'>

export function T3Providers({ t3, checkout, providerLogo, openInWorkspace }: {
  /** Null while no workspace is open. */
  t3: T3ProvidersProxy | null
  checkout?: string
  providerLogo?: (providerId: T3ProviderId) => string | undefined
  /** Opens a URL in a browser panel of the workspace `t3` serves; false when
   *  it could not. A sign-in that calls back to loopback goes there, since
   *  the CLI waits on the runtime's machine (architecture D10). */
  openInWorkspace?: (url: string) => boolean
}) {
  const [authProvider, setAuthProvider] = useState<T3ProviderLogin | null>(null)
  const [authSession, setAuthSession] = useState<T3ProviderAuthSession | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authStarting, setAuthStarting] = useState(false)
  const [openCodeProvider, setOpenCodeProvider] = useState('')
  const [copiedDeviceCode, setCopiedDeviceCode] = useState(false)
  const [authInput, setAuthInput] = useState('')
  const [providerStatuses, setProviderStatuses] = useState<T3ProviderStatus[]>([])
  const [providerStatusesLoading, setProviderStatusesLoading] = useState(false)
  const openedAuthUrlRef = useRef<string | null>(null)

  const refreshProviderStatuses = useCallback(async (): Promise<void> => {
    if (!t3) return
    setProviderStatusesLoading(true)
    try {
      setProviderStatuses(await t3.providerStatuses())
    } catch {
      // Statuses stay unknown; the rows say so.
    } finally {
      setProviderStatusesLoading(false)
    }
  }, [t3])

  useEffect(() => { void refreshProviderStatuses() }, [refreshProviderStatuses])

  const startProviderLogin = async (
    provider: T3ProviderLogin,
    openCodeTarget?: string,
  ): Promise<void> => {
    if (!t3) return
    setAuthProvider(provider)
    setAuthSession(null)
    setAuthError(null)
    setAuthStarting(true)
    setAuthInput('')
    setCopiedDeviceCode(false)
    openedAuthUrlRef.current = null
    try {
      setAuthSession(await t3.providerAuthStart({
        checkout,
        providerId: provider.id,
        ...(provider.id === 'opencode' && openCodeTarget?.trim()
          ? { provider: openCodeTarget.trim() }
          : {}),
      }))
    } catch (error) {
      setAuthError(errorMessage(error, 'Sign-in could not be started.'))
    } finally {
      setAuthStarting(false)
    }
  }

  const openProviderLogin = (provider: T3ProviderLogin): void => {
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
      void t3?.providerAuthCancel({ id: authSession.id }).catch(() => undefined)
    }
    setAuthProvider(null)
    setAuthSession(null)
    setAuthError(null)
    setAuthInput('')
  }

  const sendProviderLoginInput = (data: string): void => {
    if (authSession?.phase !== 'running') return
    void t3?.providerAuthWrite({ id: authSession.id, data }).catch(() => undefined)
  }

  useEffect(() => {
    if (authSession?.phase !== 'running' || !t3) return
    let cancelled = false
    const poll = window.setInterval(() => {
      void t3.providerAuthGet({ id: authSession.id }).then((result) => {
        if (!cancelled) setAuthSession(result)
      }, (error: unknown) => {
        if (!cancelled) setAuthError(errorMessage(error, 'Could not check sign-in status.'))
      })
    }, 400)
    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [t3, authSession?.id, authSession?.phase])

  // A loopback page itself never goes to the system browser; a page that only
  // calls back to loopback does when no workspace panel can take it.
  const openAuthUrl = (url: string): void => {
    if (providerAuthUsesLoopback(url) && openInWorkspace?.(url)) return
    if (!isLoopbackUrl(url)) clientUi().openExternal(url)
  }
  const openAuthUrlRef = useRef(openAuthUrl)
  openAuthUrlRef.current = openAuthUrl

  useEffect(() => {
    const url = authSession?.url
    if (!url || openedAuthUrlRef.current === url) return
    openedAuthUrlRef.current = url
    openAuthUrlRef.current(url)
  }, [authSession?.url])


  useEffect(() => {
    if (authSession?.phase !== 'succeeded') return
    setProviderStatuses((current) => [
      ...current.filter((status) => status.providerId !== authSession.providerId),
      { providerId: authSession.providerId, state: 'authenticated' },
    ])
    // The statuses are T3's last probe: T3 probes again to record the sign-in.
    let cancelled = false
    void t3?.providerSettings({ checkout, operation: 'refresh' })
      .then(() => { if (!cancelled) void refreshProviderStatuses() }, () => undefined)
    return () => { cancelled = true }
  }, [t3, checkout, authSession?.phase, authSession?.providerId, refreshProviderStatuses])

  return (
    <>
      <T3ProviderConfiguration t3={t3} checkout={checkout} onChanged={refreshProviderStatuses} providerLogo={providerLogo} authentication={(driver) => (
          <div>
            {T3_PROVIDER_LOGINS.filter((provider) => provider.driverId === driver).map((provider) => {
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
                        {connected && <CheckCircle size={13} />}
                        {statusLabel}
                        {versionLabel && <span className="text-muted">· {versionLabel}</span>}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <SecondaryButton
                        onClick={() => openProviderLogin(provider)}
                        disabled={!t3}
                        title={!t3 ? 'Open a workspace first' : `Sign in to ${provider.name}`}
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
              <LoadingState label="Starting official sign-in" className="py-8 text-sm" />
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
                  <span>{authSession.message ?? (authSession.phase === 'running' ? 'Waiting for sign-in' : 'Sign-in finished.')}</span>
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
                        void clientUi().writeClipboard?.(authSession.code!)
                        setCopiedDeviceCode(true)
                      }}
                    >
                      {copiedDeviceCode ? <Check size={14} /> : <Copy size={14} />}
                      {copiedDeviceCode ? 'Copied' : 'Copy code'}
                    </button>
                  </div>
                )}
                <pre className="max-h-64 min-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md border border-subtle bg-surface-0 p-3 font-mono text-xs leading-5 text-secondary select-text">
                  {authSession.output.trim() || 'Waiting for the provider to begin the login flow'}
                </pre>
                {authSession.phase === 'running' && (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!authInput) return
                      sendProviderLoginInput(`${authInput}\r`)
                      setAuthInput('')
                    }}
                  >
                    <input
                      aria-label="Sign-in response"
                      type="password"
                      autoComplete="off"
                      value={authInput}
                      onChange={(event) => setAuthInput(event.target.value)}
                      placeholder="Paste a code or API key if the provider asks for one"
                      className={inputCls}
                    />
                    <button type="submit" className={btn.secondary} disabled={!authInput}>
                      Send
                    </button>
                  </form>
                )}
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
                    <button type="button" className={btn.secondary} onClick={() => openAuthUrl(authSession.url!)}>
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
    </>
  )
}
