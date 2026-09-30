// The repository overlay: the workspace's repositories (a picker when it
// holds several), the GitHub remote with quick links, and the Source Control
// and Pull Requests tabs.

import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, FolderGit2, GitBranch, GitPullRequest, Github, Settings2 } from 'lucide-react'
import { useRuntime } from '@kernel/rpc/ui'
import { Button, clientUi, errorMessage, IconButton, LoadingState, Spinner } from '@kernel/ui'
import { pathDisplayName } from '@workspace/files/contract'
import { githubRepositoryUrl, type GitRemote, type PullRequestItem } from '../contract'
import { useRepositoryUi } from './context'
import { PullRequestsOverview } from './PullRequestsOverview'
import { SourceControlView } from './SourceControlView'

export type RepositoryTab = 'changes' | 'pullRequests'

export interface RepositoryOverviewProps {
  tab: RepositoryTab
  onTabChange: (tab: RepositoryTab) => void
  /** Draws the overlay header (client chrome) around the header actions. */
  header: (actions: ReactNode) => ReactNode
  onOpenPullRequest: (pr: PullRequestItem) => Promise<void>
}

type Remote = GitRemote
export function RepositoryOverview({ tab, onTabChange, header, onOpenPullRequest }: RepositoryOverviewProps) {
  const host = useRepositoryUi()
  const runtime = useRuntime(host.workspaceId)
  const workspace = { id: host.workspaceId, rootPath: host.root }
  const [discovery, setDiscovery] = useState<{ workspaceId: string; rootPath: string; paths: string[] } | null>(null)
  const repositories = discovery?.workspaceId === workspace?.id && discovery?.rootPath === workspace?.rootPath ? discovery?.paths ?? [] : []
  const [selected, setSelected] = useState('')
  const [remoteResult, setRemoteResult] = useState<{ workspaceId: string; root: string; items: Remote[] } | null>(null)
  const [remoteName, setRemoteName] = useState('origin')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const root = repositories.includes(selected) ? selected : repositories[0]
  const remotes = remoteResult?.workspaceId === workspace?.id && remoteResult?.root === root ? remoteResult?.items ?? [] : []
  useEffect(() => {
    let live = true
    setDiscovery(null); setError(null); setLoading(!!(workspace.rootPath && runtime))
    if (workspace.rootPath && runtime) void runtime.vcs.findRepos({ dir: workspace.rootPath, maxDepth: 3 }).then(paths => {
      if (live) setDiscovery({ workspaceId: workspace.id, rootPath: workspace.rootPath, paths })
    }).catch(e => { if (live) setError(errorMessage(e, 'Could not discover repositories.')) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [runtime, workspace.id, workspace.rootPath])
  useEffect(() => {
    let live = true
    setRemoteResult(null)
    setRemoteLoading(!!(root && runtime))
    if (root && runtime) void runtime.vcs.remotes({ cwd: root }).then(value => {
      if (live) setRemoteResult({ workspaceId: workspace.id, root, items: value })
    }).catch(e => { if (live) setError(errorMessage(e, 'Could not read remotes.')) }).finally(() => { if (live) setRemoteLoading(false) })
    return () => { live = false }
  }, [runtime, root, workspace.id])
  const remote = remotes.find(r => r.name === remoteName) ?? remotes.find(r => r.name === 'origin') ?? remotes[0]
  const url = remote && githubRepositoryUrl(remote.fetchUrl)
  const openLink = (suffix = '') => { if (url) clientUi().openExternal(url + suffix) }
  return <section aria-label="Repository" className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-canvas-bg text-primary">
    {header(<IconButton label="GitHub settings" onClick={() => clientUi().openSettings('source control')}><Settings2 size={15} /></IconButton>)}
    <div className="mx-auto flex min-h-0 w-full max-w-[1040px] flex-1 flex-col px-6 pt-4">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {repositories.length > 1 ? <select aria-label="Local repository" value={root} onChange={e => setSelected(e.target.value)} className="max-w-full rounded-lg border border-subtle bg-surface-2 px-2 py-1 text-xl font-semibold">{repositories.map(path => <option key={path} value={path}>{pathDisplayName(path)}</option>)}</select> : <h1 className="truncate text-xl font-medium">{root ? pathDisplayName(root) : 'Your repositories'}</h1>}
          {root && <p title={root} className="mt-2 truncate text-xs text-muted">{root}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-secondary">
            <>{remoteLoading ? <Spinner size={14} label="Loading repository connection" /> : <Github size={14} />}</>
            {remotes.length > 1 && <select aria-label="Git remote" value={remote?.name} onChange={e => setRemoteName(e.target.value)} className="rounded border border-subtle bg-surface-2 px-2 py-1">{remotes.map(r => <option key={r.name}>{r.name}</option>)}</select>}
            {remoteLoading ? <span>Loading remote…</span> : url ? <button onClick={() => openLink()} className="inline-flex items-center gap-1 hover:text-primary">{url.replace('https://github.com/', '')}<ExternalLink size={12} /></button> : <span>{remote ? `Remote: ${remote.name} · not hosted on GitHub` : root ? 'No remote connected' : 'Pull requests across your GitHub repositories'}</span>}
          </div>
        </div>
        {url && <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => openLink()}><Github size={14} />Open on GitHub</Button><Button variant="ghost" size="sm" onClick={() => openLink('/issues')}>Issues</Button><Button variant="ghost" size="sm" onClick={() => openLink('/actions')}>Actions</Button><Button variant="ghost" size="sm" onClick={() => openLink('/compare?expand=1')}>New pull request</Button></div>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <nav aria-label="Repository views" className="flex w-fit shrink-0 gap-0.5 rounded-lg bg-surface-1 p-0.5">
        {([['changes', 'Source Control', GitBranch], ['pullRequests', 'Pull Requests', GitPullRequest]] as const).map(([id, label, Icon]) => <button key={id} aria-pressed={tab === id} onClick={() => onTabChange(id)} className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs transition-colors ${tab === id ? 'bg-surface-3 text-primary' : 'text-muted hover:text-primary'}`}><Icon size={15} />{label}</button>)}
      </nav>
      <div className="min-h-0 flex-1 pt-4">
        {tab === 'pullRequests' ? <PullRequestsOverview workspaceId={workspace.id} onOpenPullRequest={onOpenPullRequest} initialRepository={url ? url.replace('https://github.com/', '') : ''} /> : loading ? <LoadingState label="Finding repositories…" className="p-8 text-sm" /> : root ? <SourceControlView key={workspace.id + root} rootPath={root} /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted"><FolderGit2 size={32} /><p>No Git repository found in this workspace.</p><Button onClick={() => onTabChange('pullRequests')}>Browse pull requests</Button></div>}
      </div>
    </div>
  </section>
}
