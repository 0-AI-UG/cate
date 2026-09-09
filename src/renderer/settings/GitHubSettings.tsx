import { LoadingState, Spinner } from '../ui/Spinner'
import { useEffect, useState } from 'react'
import { Github, RefreshCw } from 'lucide-react'
import type { GitHubConnection, GitHubLoginState } from '../../shared/pullRequests'
import { SearchableBlock, SecondaryButton } from './SettingsComponents'
import { useUIStore } from '../stores/uiStore'

export function GitHubSettings() {
  const [connection, setConnection] = useState<GitHubConnection | null>(null)
  const [login, setLogin] = useState<GitHubLoginState>({ status: 'idle' })
  const [checking, setChecking] = useState(false)
  async function refresh() {
    setChecking(true)
    try { setConnection(await window.electronAPI.githubConnection()) }
    catch { setConnection({ status: 'error', message: 'Could not check GitHub. Restart Cate if it was just updated, then retry.' }) }
    finally { setChecking(false) }
  }
  useEffect(() => { void refresh() }, [])
  useEffect(() => {
    if (login.status !== 'pending') return
    const timer = setInterval(() => {
      void window.electronAPI.githubLogin('status').then((state) => {
        setLogin(state)
        if (state.status === 'complete') void refresh()
      }).catch(() => setLogin({ status: 'error', message: 'Could not check sign-in. Try again.' }))
    }, 1000)
    return () => clearInterval(timer)
  }, [login.status])
  async function changeLogin(operation: 'start' | 'cancel') {
    if (operation === 'start') setLogin({ status: 'pending' })
    try { setLogin(await window.electronAPI.githubLogin(operation)) }
    catch { setLogin({ status: 'error', message: 'Could not update GitHub sign-in. Try again.' }) }
  }
  const connected = connection?.status === 'connected'
  return <SearchableBlock keywords="source control providers github account authentication login sign in gh cli pull requests">
    <div className="overflow-hidden rounded-xl border border-subtle">
      <div className="flex flex-wrap items-center gap-4 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <span className="relative"><Github size={22} /><span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface-1" style={{ backgroundColor: connected ? 'var(--git-added)' : 'var(--text-muted)' }} /></span>
            <span className="text-sm font-medium text-primary">GitHub</span>
            {connection?.version && <span className="font-mono text-xs text-muted">{connection.version}</span>}
          </div>
          {!connection ? <LoadingState label="Checking GitHub…" size={13} className="mt-2 justify-start text-xs" /> : <p role="status" className="mt-2 text-xs text-muted">{connected ? `Authenticated as ${connection.account}` : connection.message}</p>}
        </div>
        <div className="flex items-center gap-2">
          {connected ? <SecondaryButton onClick={() => useUIStore.getState().setShowPullRequests(true)}>Pull requests</SecondaryButton> : connection?.status === 'missing-cli' ?
            <SecondaryButton onClick={() => void window.electronAPI.openExternalUrl('https://cli.github.com/')}>Install GitHub CLI</SecondaryButton> :
            <SecondaryButton disabled={!connection || login.status === 'pending'} onClick={() => void changeLogin('start')}>Sign in to GitHub</SecondaryButton>}
          <SecondaryButton disabled={checking} onClick={() => void refresh()} aria-label="Recheck GitHub connection">{checking ? <Spinner size={14} /> : <RefreshCw size={14} />}Recheck</SecondaryButton>
        </div>
      </div>
      <div className="border-t border-subtle px-4 py-3 text-xs text-muted">Uses the GitHub CLI account on this computer, shared with your terminals. Remote workspaces use their own GitHub CLI authentication.</div>
    </div>
    {login.status === 'pending' && <div role="status" className="mt-3 text-sm text-secondary">
      <Spinner size={14} className="mr-2 align-middle" />{login.code ? <>Enter <strong className="select-all font-mono">{login.code}</strong> on GitHub to finish signing in.</> : 'Starting GitHub sign-in…'}
      <div className="mt-2 flex gap-2"><SecondaryButton onClick={() => void window.electronAPI.openExternalUrl('https://github.com/login/device')}>Open GitHub</SecondaryButton><SecondaryButton onClick={() => void changeLogin('cancel')}>Cancel</SecondaryButton></div>
    </div>}
    {login.status === 'error' && <p role="alert" className="mt-3 text-xs text-danger">{login.message}</p>}
  </SearchableBlock>
}
