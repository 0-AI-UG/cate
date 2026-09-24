import { useCallback, useEffect, useRef, useState } from 'react'
import type { T3RemoteOperation, T3RemoteSession } from '../../shared/t3Agent'
import { errorMessage } from '../lib/errorMessage'
import { SecondaryButton } from './SettingsComponents'

export function T3RemoteAccess({ workspaceId, cwd }: { workspaceId: string; cwd: string }) {
  const [session, setSession] = useState<T3RemoteSession | null>(null)
  const [error, setError] = useState('')
  const [input, setInput] = useState('')
  const runningId = useRef<string | null>(null)
  const start = useCallback(async (operation: T3RemoteOperation) => {
    setError('')
    setSession(null)
    try {
      const result = await window.electronAPI.agentRemoteStart({ workspaceId, cwd, operation })
      if ('error' in result) setError(result.error)
      else setSession(result)
    } catch (cause) { setError(errorMessage(cause, 'T3 Connect could not start.')) }
  }, [workspaceId, cwd])

  useEffect(() => {
    if (!workspaceId || !cwd) return
    void start('status')
  }, [workspaceId, cwd, start])

  const sessionId = session?.id
  const sessionPhase = session?.phase
  useEffect(() => {
    if (!sessionId || sessionPhase !== 'running') return
    const id = sessionId
    const timer = window.setInterval(() => {
      void window.electronAPI.agentRemoteGet({ id }).then((result) => {
        if ('error' in result) setError(result.error)
        else setSession((current) => current?.id === id ? result : current)
      }).catch((cause) => setError(errorMessage(cause, 'Could not read T3 Connect status.')))
    }, 500)
    return () => window.clearInterval(timer)
  }, [sessionId, sessionPhase])

  useEffect(() => {
    runningId.current = session?.phase === 'running' ? session.id : null
  }, [session])
  useEffect(() => () => {
    if (runningId.current) void window.electronAPI.agentRemoteCancel({ id: runningId.current })
  }, [])

  const send = (data: string) => {
    if (!session || session.phase !== 'running') return
    void window.electronAPI.agentRemoteWrite({ id: session.id, data })
    setInput('')
  }

  const busy = session?.phase === 'running'
  const authorizationUrl = session?.operation === 'link'
    ? session.output.match(/https:\/\/[^\s<>"']+/)?.[0].replace(/[),.;]+$/, '')
    : undefined
  return <section className="border-t border-subtle pt-4">
    <h3 className="text-sm font-medium text-primary">T3 Connect</h3>
    <p className="mt-1 text-xs text-muted">Reach this checkout’s T3 conversations from your phone. Keep this Mac awake, online, and running Cate. T3 Connect uses a managed remote tunnel; no VPS or port forwarding is needed.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <SecondaryButton disabled={!cwd || busy} onClick={() => void start('link')}>Enable T3 Connect</SecondaryButton>
      <SecondaryButton disabled={!cwd || busy} onClick={() => void start('unlink')}>Disable</SecondaryButton>
      <SecondaryButton disabled={!cwd || busy} onClick={() => void start('status')}>Refresh status</SecondaryButton>
      {busy && <SecondaryButton onClick={() => void window.electronAPI.agentRemoteCancel({ id: session.id })}>Cancel</SecondaryButton>}
    </div>
    {!cwd && <p className="mt-2 text-xs text-muted">Open a local workspace first.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
    {session?.message && <p role="status" className="mt-2 text-xs text-muted">{session.message}</p>}
    {authorizationUrl && <SecondaryButton onClick={() => window.electronAPI.openExternalUrl(authorizationUrl)}>Open authorization page</SecondaryButton>}
    {session?.output && <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-raised p-3 text-xs text-primary">{session.output}</pre>}
    {busy && session.operation === 'link' && <div className="mt-2 flex gap-2">
      <input aria-label="T3 Connect response" className="min-w-0 flex-1 rounded border border-subtle bg-surface px-2 text-xs text-primary" value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') send(`${input}\n`) }} placeholder="Reply to a T3 prompt, if needed" />
      <SecondaryButton onClick={() => send(`${input}\n`)}>Send</SecondaryButton>
    </div>}
  </section>
}
