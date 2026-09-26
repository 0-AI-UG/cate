import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Copy, Link2, RefreshCw } from 'lucide-react'
import type { T3RemoteOperation, T3RemoteSession } from '../../shared/t3Agent'
import { errorMessage } from '../lib/errorMessage'
import { SecondaryButton } from './SettingsComponents'

interface ConnectStatus {
  desired: boolean
  authenticated: boolean
  linked: boolean
}

function readConnectStatus(output: string): ConnectStatus | null {
  try {
    const value = JSON.parse(output) as Partial<ConnectStatus>
    if (typeof value.desired !== 'boolean' || typeof value.authenticated !== 'boolean' || typeof value.linked !== 'boolean') return null
    return { desired: value.desired, authenticated: value.authenticated, linked: value.linked }
  } catch { return null }
}

export function T3RemoteAccess({ workspaceId, cwd }: { workspaceId: string; cwd: string }) {
  const [session, setSession] = useState<T3RemoteSession | null>(null)
  const [status, setStatus] = useState<ConnectStatus | null>(null)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [relayChoiceSent, setRelayChoiceSent] = useState(false)
  const [browserOpened, setBrowserOpened] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  const runningId = useRef<string | null>(null)

  const start = useCallback(async (operation: T3RemoteOperation) => {
    setError('')
    setSession(null)
    setStarting(true)
    setRelayChoiceSent(false)
    setBrowserOpened(false)
    setLinkCopied(false)
    if (operation !== 'status') setStatus(null)
    try {
      const result = await window.electronAPI.agentRemoteStart({ workspaceId, cwd, operation })
      if ('error' in result) setError(result.error)
      else setSession(result)
    } catch (cause) { setError(errorMessage(cause, 'T3 Connect could not start.')) }
    finally { setStarting(false) }
  }, [workspaceId, cwd])

  useEffect(() => {
    if (workspaceId && cwd) void start('status')
  }, [workspaceId, cwd, start])

  useEffect(() => {
    if (!session || session.phase !== 'running') return
    const id = session.id
    const timer = window.setInterval(() => {
      void window.electronAPI.agentRemoteGet({ id }).then((result) => {
        if ('error' in result) setError(result.error)
        else setSession((current) => current?.id === id ? result : current)
      }).catch((cause) => setError(errorMessage(cause, 'Could not read T3 Connect status.')))
    }, 500)
    return () => window.clearInterval(timer)
  }, [session])

  useEffect(() => {
    if (session?.operation === 'status' && session.phase === 'succeeded') setStatus(readConnectStatus(session.output))
    if (session?.phase === 'succeeded' && session.operation !== 'status') void start('status')
  }, [session, start])

  useEffect(() => { runningId.current = session?.phase === 'running' ? session.id : null }, [session])
  useEffect(() => () => {
    if (runningId.current) void window.electronAPI.agentRemoteCancel({ id: runningId.current })
  }, [])

  const send = (data: string) => {
    if (!session || session.phase !== 'running') return
    void window.electronAPI.agentRemoteWrite({ id: session.id, data }).then((result) => {
      if (result.error) setError(result.error)
    }).catch((cause) => setError(errorMessage(cause, 'Could not send response.')))
  }

  const busy = starting || session?.phase === 'running'
  const needsRelayApproval = session?.operation === 'link' && session.phase === 'running'
    && /Download and install version [^?]+\?/.test(session.output)
    && !session.authorizationUrl && !relayChoiceSent
  const awaitingBrowser = session?.operation === 'link' && session.phase === 'running' && Boolean(session.authorizationUrl)
  const statusLabel = status?.linked ? 'Enabled' : status?.desired ? 'Finishing setup' : status?.authenticated ? 'Ready to enable' : status ? 'Off'
    : session?.operation === 'status' && session.phase !== 'running' ? 'Status unavailable' : 'Checking…'

  return <section className="border-t border-subtle pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Link2 size={18} className="mt-0.5 shrink-0 text-secondary" />
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-primary">T3 Connect</h3>
          <p role="status" className="mt-1 text-xs text-muted">{statusLabel} · Reach this checkout from your phone while Cate is running on this Mac.</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SecondaryButton disabled={!cwd || busy} onClick={() => void start('link')}>{status?.desired ? 'Reconnect' : 'Enable'}</SecondaryButton>
        {status?.desired && <SecondaryButton disabled={!cwd || busy} onClick={() => void start('unlink')}>Disable</SecondaryButton>}
        <SecondaryButton disabled={!cwd || busy} aria-label="Refresh T3 Connect status" title="Refresh status" onClick={() => void start('status')}><RefreshCw size={13} /></SecondaryButton>
      </div>
    </div>
    {!cwd && <p className="mt-2 text-xs text-muted">Open a local workspace first.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    {session?.message && <p role="status" className="mt-2 text-xs text-secondary">{session.message}</p>}
    {status?.linked && <div className="mt-3 rounded-md border border-subtle bg-surface-1 p-3">
      <p className="text-[13px] font-medium text-primary">Connect your phone</p>
      <p className="mt-1 text-xs text-muted">Open T3 Code on your phone, sign in to the same T3 Connect account, then select this Mac’s environment. A QR code is only used for direct network pairing.</p>
    </div>}

    {needsRelayApproval && <div className="mt-3 rounded-md border border-subtle bg-surface-1 p-3">
      <p className="text-[13px] font-medium text-primary">Install the relay client</p>
      <p className="mt-1 text-xs text-muted">T3 Connect uses a managed relay client to reach this Mac.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton onClick={() => { send('y'); setRelayChoiceSent(true) }}>Install and continue</SecondaryButton>
        <SecondaryButton onClick={() => { send('n'); setRelayChoiceSent(true) }}>Cancel setup</SecondaryButton>
      </div>
    </div>}

    {awaitingBrowser && <div className="mt-3 rounded-md border border-subtle bg-surface-1 p-3">
      <p className="text-[13px] font-medium text-primary">Authorize T3 Connect</p>
      <p className="mt-1 text-xs text-muted">Open the sign-in page in your browser. Cate will finish connecting after you sign in.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <SecondaryButton onClick={() => { send('\r'); setBrowserOpened(true) }}><ArrowUpRight size={13} />{browserOpened ? 'Open again' : 'Open sign-in page'}</SecondaryButton>
        <SecondaryButton onClick={() => { void window.electronAPI.terminalClipboardWrite(session.authorizationUrl!); setLinkCopied(true) }}>{linkCopied ? <Check size={13} /> : <Copy size={13} />}{linkCopied ? 'Copied' : 'Copy link'}</SecondaryButton>
        <SecondaryButton onClick={() => void window.electronAPI.agentRemoteCancel({ id: session.id })}>Cancel</SecondaryButton>
      </div>
      {browserOpened && <p role="status" className="mt-3 text-xs text-muted">Waiting for browser sign-in…</p>}
    </div>}

    {session?.phase === 'running' && !needsRelayApproval && !awaitingBrowser && <p role="status" className="mt-3 text-xs text-muted">{session.operation === 'link' ? 'Preparing T3 Connect…' : 'Checking T3 Connect…'}</p>}
    {session?.output && (session.operation !== 'status' || !status) && <details className="mt-3 text-xs text-muted">
      <summary className="cursor-pointer">Connection details</summary>
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-subtle bg-surface-0 p-3 font-mono text-xs leading-5 text-secondary select-text">{session.output}</pre>
    </details>}
  </section>
}
