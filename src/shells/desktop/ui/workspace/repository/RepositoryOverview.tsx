// The repository overlay: the workspace's repositories (a picker when it
// holds several), the GitHub remote with quick links, and the Source Control
// and Pull Requests tabs.

import { useEffect, useState, type ReactNode } from 'react'
import { ExternalLink, FolderGit2, GitBranch, GitPullRequest, Github, Settings2 } from 'lucide-react'
import { useRuntime } from '../../kernel/rpc'
import { Button, IconButton, LoadingState, Spinner } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { pathDisplayName } from '@workspace/files/contract'
import { githubRepositoryUrl, type GitRemote, type PullRequestItem } from '@workspace/repository/contract'
import { useRepositoryUi } from './context'
import { PullRequestsOverview } from './PullRequestsOverview'
import { SourceControlView } from './SourceControlView'
import { repositoryReadCacheFor } from './readCache'

export type RepositoryTab = 'changes' | 'pullRequests'

export interface RepositoryOverviewProps {
  tab: RepositoryTab
  onOpenFile?(): void
  onTabChange: (tab: RepositoryTab) => void
  /** Draws the overlay header (client chrome) around the header actions. */
  header: (actions: ReactNode) => ReactNode
  onOpenPullRequest: (pr: PullRequestItem) => Promise<void>
}

type Remote = GitRemote
export function RepositoryOverview({ tab, onTabChange, header, onOpenPullRequest, onOpenFile }: RepositoryOverviewProps) {
  const host = useRepositoryUi()
  const runtime = useRuntime(host.workspaceId)
  const cache = runtime ? repositoryReadCacheFor(runtime) : null
  const workspace = { id: host.workspaceId, rootPath: host.root }
  const [discovery, setDiscovery] = useState<{ workspaceId: string; rootPath: string; paths: string[] } | null>(() => {
    const paths = cache?.peek('findRepos', { dir: host.root, maxDepth: 3 })
    return paths ? { workspaceId: host.workspaceId, rootPath: host.root, paths } : null
  })
  const repositories = discovery?.workspaceId === workspace?.id && discovery?.rootPath === workspace?.rootPath ? discovery?.paths ?? [] : []
  const [selected, setSelected] = useState('')
  const [remoteResult, setRemoteResult] = useState<{ workspaceId: string; root: string; items: Remote[] } | null>(null)
  const [remoteName, setRemoteName] = useState('origin')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const discovering = !!workspace.rootPath && (!runtime || loading || (!discovery && !error))
  const root = repositories.includes(selected) ? selected : repositories[0]
  const remotes = remoteResult?.workspaceId === workspace?.id && remoteResult?.root === root ? remoteResult?.items ?? [] : []
  useEffect(() => {
    let live = true
    const args = { dir: workspace.rootPath, maxDepth: 3 }
    const cached = cache?.peek('findRepos', args)
    setDiscovery(cached ? { workspaceId: workspace.id, rootPath: workspace.rootPath, paths: cached } : null); setError(null); setLoading(!!(workspace.rootPath && cache && !cached))
    if (workspace.rootPath && cache) void cache.read('findRepos', args).then(paths => {
      if (live) setDiscovery({ workspaceId: workspace.id, rootPath: workspace.rootPath, paths })
    }).catch(e => { if (live) setError(errorMessage(e, 'Could not discover repositories.')) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cache, workspace.id, workspace.rootPath])
  useEffect(() => {
    let live = true
    const cached = root ? cache?.peek('remotes', { cwd: root }) : undefined
    setRemoteResult(cached && root ? { workspaceId: workspace.id, root, items: cached } : null)
    setRemoteLoading(!!(root && cache && !cached))
    if (root && cache) void cache.read('remotes', { cwd: root }).then(value => {
      if (live) setRemoteResult({ workspaceId: workspace.id, root, items: value })
    }).catch(e => { if (live) setError(errorMessage(e, 'Could not read remotes.')) }).finally(() => { if (live) setRemoteLoading(false) })
    return () => { live = false }
  }, [cache, root, workspace.id])
  const checkingRemote = !!root && (!runtime || remoteLoading || (!remoteResult && !error))
  const remote = remotes.find(r => r.name === remoteName) ?? remotes.find(r => r.name === 'origin') ?? remotes[0]
  const url = remote && githubRepositoryUrl(remote.fetchUrl)
  const openLink = (suffix = '') => { if (url) clientUi().openExternal(url + suffix) }
  return <section aria-label="Repository" className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-canvas-bg text-primary">
    {header(<IconButton label="GitHub settings" onClick={() => clientUi().openSettings('github')}><Settings2 size={15} /></IconButton>)}
    <div className="mx-auto flex min-h-0 w-full max-w-[1280px] flex-1 flex-col px-6 pt-3">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-medium">{root ? pathDisplayName(root) : 'Your repositories'}</h1>
          {repositories.length > 1 && <div role="group" aria-label="Local repository" className="mt-2 flex flex-wrap gap-1">{repositories.map(path => <button key={path} aria-pressed={path === root} title={path} onClick={() => setSelected(path)} className={`rounded-md px-2 py-1 text-xs ${path === root ? 'bg-surface-3 text-primary' : 'text-muted hover:bg-hover hover:text-primary'}`}>{pathDisplayName(path)}</button>)}</div>}
          {root && <p title={root} className="mt-1 truncate text-xs text-muted">{root}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-secondary">
            <>{checkingRemote ? <Spinner size={14} label="Loading repository connection" /> : <Github size={14} />}</>
            {remotes.length > 1 && <div role="group" aria-label="Git remote" className="flex gap-1">{remotes.map(r => <button key={r.name} aria-pressed={r.name === remote?.name} onClick={() => setRemoteName(r.name)} className={`rounded px-2 py-1 ${r.name === remote?.name ? 'bg-surface-3 text-primary' : 'text-muted hover:bg-hover hover:text-primary'}`}>{r.name}</button>)}</div>}
            {checkingRemote ? <span>Loading remote</span> : url ? <button onClick={() => openLink()} className="inline-flex items-center gap-1 hover:text-primary">{url.replace('https://github.com/', '')}<ExternalLink size={12} /></button> : <span>{remote ? `Remote: ${remote.name} · not hosted on GitHub` : root ? error ? '' : 'No remote connected' : 'Pull requests across your GitHub repositories'}</span>}
          </div>
        </div>
        {url && <div className="flex flex-wrap gap-2"><Button variant="ghost" size="sm" onClick={() => openLink()}><Github size={14} />GitHub</Button><Button variant="ghost" size="sm" onClick={() => openLink('/issues')}>Issues</Button><Button variant="ghost" size="sm" onClick={() => openLink('/actions')}>Actions</Button><Button variant="ghost" size="sm" onClick={() => openLink('/compare?expand=1')}>New pull request</Button></div>}
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
      <nav aria-label="Repository views" className="flex shrink-0 gap-5 border-b border-subtle">
        {([['changes', 'Source Control', GitBranch], ['pullRequests', 'Pull Requests', GitPullRequest]] as const).map(([id, label, Icon]) => <button key={id} aria-pressed={tab === id} onClick={() => onTabChange(id)} className={`-mb-px flex items-center gap-2 border-b-2 px-1 py-2 text-xs transition-colors ${tab === id ? 'border-current text-primary' : 'border-transparent text-muted hover:text-primary'}`}><Icon size={15} />{label}</button>)}
      </nav>
      <div className="min-h-0 flex-1 pt-3">
        {tab === 'pullRequests' ? <PullRequestsOverview workspaceId={workspace.id} onOpenPullRequest={onOpenPullRequest} initialRepository={url ? url.replace('https://github.com/', '') : ''} /> : discovering ? <LoadingState label="Finding repositories" className="p-8 text-sm" /> : root ? <SourceControlView onOpenFile={onOpenFile} key={workspace.id + root} rootPath={root} /> : error ? null : <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted"><FolderGit2 size={32} /><p>No Git repository found in this workspace.</p><Button onClick={() => onTabChange('pullRequests')}>Browse pull requests</Button></div>}
      </div>
    </div>
  </section>
}
