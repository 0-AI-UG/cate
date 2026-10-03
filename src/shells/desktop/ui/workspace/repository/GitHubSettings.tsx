// Settings: the GitHub CLI account of the workspace's runtime host.

import { useEffect, useState } from 'react'
import { Github, RefreshCw } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { clientUi } from '@kernel/interaction'
import { LoadingState, Spinner, SearchableBlock, SecondaryButton } from '../../kernel/interaction'
import type { GitHubConnection, GitHubLoginState } from '@workspace/repository/contract'

export interface GitHubSettingsProps {
  workspaceId: string
  onShowPullRequests: () => void
}

export function GitHubSettings({ workspaceId, onShowPullRequests }: GitHubSettingsProps) {
  const runtime = useRuntime(workspaceId)
  const [connection, setConnection] = useState<GitHubConnection | null>(null)
  const [login, setLogin] = useState<GitHubLoginState>({ status: 'idle' })
  const [checking, setChecking] = useState(false)
  async function refresh() {
    if (!runtime) return
    setChecking(true)
    try { setConnection(await runtime.vcs.githubConnection()) }
    catch { setConnection({ status: 'error', message: 'Could not check GitHub. Restart Cate if it was just updated, then retry.' }) }
    finally { setChecking(false) }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh() }, [runtime])
  useEffect(() => {
    if (login.status !== 'pending' || !runtime) return
    const timer = setInterval(() => {
      void runtime.vcs.githubLogin({ operation: 'state' }).then((state) => {
        setLogin(state)
        if (state.status === 'complete') void refresh()
      }).catch(() => setLogin({ status: 'error', message: 'Could not check sign-in. Try again.' }))
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [login.status, runtime])
  async function changeLogin(operation: 'start' | 'cancel') {
    if (!runtime) return
    if (operation === 'start') setLogin({ status: 'pending' })
    try { setLogin(await runtime.vcs.githubLogin({ operation })) }
    catch { setLogin({ status: 'error', message: 'Could not update GitHub sign-in. Try again.' }) }
  }
  const connected = connection?.status === 'connected'
  return <SearchableBlock keywords="source control providers github account authentication login sign in gh cli pull requests">
    <div>
      <div className="flex flex-wrap items-center gap-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="relative"><Github size={22} /><span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface-1" style={{ backgroundColor: connected ? 'var(--git-added)' : 'var(--text-muted)' }} /></span>
            <span className="text-sm font-medium text-primary">GitHub</span>
            {connection?.version && <span className="font-mono text-xs text-muted">{connection.version}</span>}
          </div>
          {!connection ? <LoadingState label="Checking GitHub" size={13} className="mt-2 justify-start text-xs" /> : <p role="status" className="mt-2 text-xs text-muted">{connected ? `Authenticated as ${connection.account}` : connection.message}</p>}
        </div>
        <div className="flex items-center gap-2">
          {connected ? <SecondaryButton onClick={onShowPullRequests}>Pull requests</SecondaryButton> : connection?.status === 'missing-cli' ?
            <SecondaryButton onClick={() => clientUi().openExternal('https://cli.github.com/')}>Install GitHub CLI</SecondaryButton> :
            <SecondaryButton disabled={!connection || login.status === 'pending'} onClick={() => void changeLogin('start')}>Sign in to GitHub</SecondaryButton>}
          <SecondaryButton disabled={checking} onClick={() => void refresh()} aria-label="Recheck GitHub connection">{checking ? <Spinner size={14} /> : <RefreshCw size={14} />}Recheck</SecondaryButton>
        </div>
      </div>
      <div className="py-2 text-xs text-muted">Uses the GitHub CLI account on the computer this workspace runs on.</div>
    </div>
    {login.status === 'pending' && <div role="status" className="mt-3 text-sm text-secondary">
      <Spinner size={14} className="mr-2 align-middle" />{login.code ? <>Enter <strong className="select-all font-mono">{login.code}</strong> on GitHub to finish signing in.</> : 'Starting GitHub sign-in'}
      <div className="mt-2 flex gap-2"><SecondaryButton onClick={() => clientUi().openExternal('https://github.com/login/device')}>Open GitHub</SecondaryButton><SecondaryButton onClick={() => void changeLogin('cancel')}>Cancel</SecondaryButton></div>
    </div>}
    {login.status === 'error' && <p role="alert" className="mt-3 text-xs text-danger">{login.message}</p>}
  </SearchableBlock>
}
