import { LoadingState, Spinner } from '../ui/Spinner'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownUp, ListFilter, CheckCircle2, CircleX, GitPullRequest, Github, Settings2, ExternalLink, RefreshCw, Search } from 'lucide-react'
import { Button, IconButton } from '../ui/Button'
import { PaletteTextInput } from '../ui/PaletteTextInput'
import { PopoverSurface, useNodePopover } from '../ui/Popover'
import { useUIStore } from '../stores/uiStore'
import { openPullRequest } from './openPullRequest'
import type { PullRequestItem, GitHubLoginState, PullRequestsResult } from '../../shared/pullRequests'

export default function PullRequestsOverview({ initialRepository = '' }: { initialRepository?: string }) {
  const visible = useUIStore((s) => s.showPullRequests)
  const [result, setResult] = useState<PullRequestsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState<string | null>(null)
  const openingRef = useRef(false)
  const [openError, setOpenError] = useState<string | null>(null)
  async function openInCate(pr: PullRequestItem) {
    if (openingRef.current) return
    openingRef.current = true
    setOpening(pr.id)
    setOpenError(null)
    try { await openPullRequest(pr) }
    catch (error) { setOpenError(error instanceof Error ? error.message : 'Could not open pull request.') }
    finally { openingRef.current = false; setOpening(null) }
  }
  const [query, setQuery] = useState('')
  const [repository, setRepository] = useState(initialRepository)
  useEffect(() => setRepository(initialRepository), [initialRepository])
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('updated')
  const [login, setLogin] = useState<GitHubLoginState>({ status: 'idle' })
  const load = async (refresh = false) => {
    setLoading(true)
    try { setResult(await window.electronAPI.pullRequestsList(refresh)) }
    catch { setResult({ status: 'error', message: 'Could not load pull requests. Restart Cate if it was just updated, then try again.' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { if (visible) void load() }, [visible])
  useEffect(() => {
    if (login.status !== 'pending') return
    const timer = setInterval(() => {
      void window.electronAPI.githubLogin('status').then((next) => {
        setLogin(next)
        if (next.status === 'complete') void load(true)
      }).catch(() => setLogin({ status: 'error', message: 'Could not check GitHub sign-in. Try again.' }))
    }, 1000)
    return () => clearInterval(timer)
  }, [login.status])
  const signIn = async () => {
    setLogin({ status: 'pending' })
    try { setLogin(await window.electronAPI.githubLogin('start')) }
    catch { setLogin({ status: 'error', message: 'Could not start GitHub sign-in. Try again.' }) }
  }
  const items = result?.status === 'ready' ? result.items : []
  const repositories = [...new Set([...items.map((pr) => pr.repository), ...(initialRepository ? [initialRepository] : [])])].sort()
  const filtered = useMemo(() => items.filter((pr) => {
    const text = `${pr.title} ${pr.repository} ${pr.author} #${pr.number}`.toLowerCase()
    return query.toLowerCase().trim().split(/\s+/).every((term) => text.includes(term)) &&
      (!repository || pr.repository === repository) &&
      (filter === 'all' || filter === pr.involvement || (filter === 'draft' && pr.draft))
  }).sort((a, b) => sort === 'oldest' ? a.updatedAt.localeCompare(b.updatedAt) : sort === 'changes' ?
    b.additions + b.deletions - a.additions - a.deletions : b.updatedAt.localeCompare(a.updatedAt)), [items, query, repository, filter, sort])
  if (!visible) return null
  return (
    <section aria-label="Pull requests" className="flex h-full min-h-0 flex-col text-primary">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 pb-4">
          <PaletteTextInput icon={<Search size={14} />} aria-label="Search pull requests" placeholder="Search pull requests, repository, or author" value={query} onChange={(e) => setQuery(e.target.value)} containerClassName="min-w-[180px] flex-1" />
          <ToolbarPopover label="Sort" icon={<ArrowDownUp size={14} />}>
            <label className="flex flex-col gap-2 text-xs text-secondary">Sort pull requests
              <select aria-label="Sort pull requests" value={sort} onChange={(e) => setSort(e.target.value)} className="h-8 rounded-md border border-subtle bg-surface-2 px-2 text-xs">
                <option value="updated">Recently updated</option><option value="oldest">Oldest updated</option><option value="changes">Most changes</option>
              </select>
            </label>
          </ToolbarPopover>
          <ToolbarPopover label="Filters" icon={<ListFilter size={14} />} active={filter !== 'all' || !!repository}>
            <label className="flex flex-col gap-2 text-xs text-secondary">Show
              <select aria-label="Filter pull requests" value={filter} onChange={(e) => setFilter(e.target.value)} className="h-8 rounded-md border border-subtle bg-surface-2 px-2 text-xs">
                <option value="all">All open</option><option value="authored">Authored</option><option value="review">Review requested</option><option value="draft">Drafts</option>
              </select>
            </label>
            <label className="mt-4 flex flex-col gap-2 text-xs text-secondary">Repository
              <select aria-label="Repository" value={repository} onChange={(e) => setRepository(e.target.value)} className="h-8 min-w-0 rounded-md border border-subtle bg-surface-2 px-2 text-xs">
                <option value="">All repositories</option>{repositories.map((repo) => <option key={repo}>{repo}</option>)}
              </select>
            </label>
            {(filter !== 'all' || repository) && <Button variant="ghost" size="sm" className="mt-3" onClick={() => { setFilter('all'); setRepository('') }}>Reset filters</Button>}
          </ToolbarPopover>
          <IconButton label="GitHub settings" size={32} onClick={() => useUIStore.getState().openSettings('source control')}><Settings2 size={14} /></IconButton>
          <IconButton label="Refresh pull requests" size={32} loading={loading} onClick={() => void load(true)} className="border border-subtle"><RefreshCw size={14} /></IconButton>
        </div>
        {openError && <p role="alert" className="mb-3 text-sm text-danger">{openError}</p>}
        {login.status === 'pending' && <div role="status" className="mb-4 rounded-lg border border-subtle p-4 text-sm">
          <Spinner size={14} className="mr-2 align-middle" />{login.code ? <>Enter <strong className="select-all font-mono">{login.code}</strong> on GitHub to finish signing in.</> : 'Starting GitHub sign-in…'}
          <div className="mt-3 flex gap-4">
            <button onClick={() => void window.electronAPI.openExternalUrl('https://github.com/login/device')} className="text-accent">Open GitHub</button>
            <button onClick={() => void window.electronAPI.githubLogin('cancel').then(setLogin)} className="text-muted">Cancel</button>
          </div>
        </div>}
        {login.status === 'error' && <p role="alert" className="mb-3 text-sm text-muted">{login.message}</p>}
        {!result && loading ? <LoadingState label="Loading pull requests…" className="py-12 text-sm" /> : result && result.status !== 'ready' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
            <Github size={28} className="text-muted" /><p className="max-w-md text-sm text-muted">{result.message}</p>
            {result.status === 'missing-cli' ? <button onClick={() => void window.electronAPI.openExternalUrl('https://cli.github.com/')} className="rounded-lg bg-surface-2 px-4 py-2 text-sm">Get GitHub CLI</button> :
              result.status === 'signed-out' ? <button disabled={login.status === 'pending'} onClick={() => void signIn()} className="rounded-lg bg-surface-2 px-4 py-2 text-sm disabled:opacity-50">Sign in to GitHub</button> : <button onClick={() => void load(true)} className="text-sm text-accent">Retry</button>}
            <p className="max-w-md text-xs text-muted">Cate uses your GitHub CLI account. Signing in also makes that account available to gh in your terminals.</p>
          </div>
        ) : <div className="min-h-0 flex-1 overflow-y-auto">
          {(['authored', 'review'] as const).map((group) => {
            const rows = filtered.filter((pr) => pr.involvement === group)
            if (!rows.length) return null
            return <section key={group} className="mb-5"><h2 className="mb-1 px-3 text-xs font-medium text-muted">{group === 'authored' ? 'Authored' : 'Review requested'}</h2>
              {rows.map((pr) => <div key={pr.id} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-hover">
                <GitPullRequest size={16} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1"><span className="block truncate text-[13px] text-primary">{pr.title}</span><span className="mt-1 block truncate text-[11px] text-muted">#{pr.number} · {pr.repository} · {pr.author}{pr.draft ? ' · Draft' : ''}</span></span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                  {pr.checks === 'SUCCESS' ? <CheckCircle2 size={15} className="text-diff-add" aria-label="Checks passed" /> : pr.checks === 'FAILURE' || pr.checks === 'ERROR' ? <CircleX size={15} className="text-danger" aria-label="Checks failed" /> : null}
                  <span className="text-diff-add">+{pr.additions.toLocaleString()}</span><span className="text-danger">−{pr.deletions.toLocaleString()}</span>
                  <time dateTime={pr.updatedAt} title={new Date(pr.updatedAt).toLocaleString()} className="ml-1 min-w-[54px] text-right text-muted">{relativeDate(pr.updatedAt)}</time>
                </span>
                  <Button size="sm" loading={opening === pr.id} disabled={opening !== null} onClick={() => void openInCate(pr)}>{opening === pr.id ? 'Opening…' : 'Open in Cate'}</Button>
                  <IconButton label={`Open pull request #${pr.number} on GitHub`} title="Open pull request on GitHub" onClick={() => void window.electronAPI.openExternalUrl(pr.url)}><ExternalLink size={14} /></IconButton>
              </div>)}
            </section>
          })}
          {result?.status === 'ready' && !filtered.length && <p className="py-12 text-center text-sm text-muted">{items.length ? 'No pull requests match your filters.' : 'No open pull requests authored by you or awaiting your review.'}</p>}
          {result?.status === 'ready' && result.truncated && <p className="py-3 text-xs text-muted">Showing up to 100 recently updated pull requests per group. Open GitHub for the full list.</p>}
        </div>}
      </div>
    </section>
  )
}

function relativeDate(value: string): string {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000))
  return days === 0 ? 'Today' : `${days}d ago`
}

function ToolbarPopover({ label, icon, active, children }: { label: string; icon: React.ReactNode; active?: boolean; children: React.ReactNode }) {
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useNodePopover(trigger, (rect) => ({ left: Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248)), gap: 6 }))
  return <>
    <Button ref={trigger} aria-expanded={popover.open} aria-haspopup="dialog" onClick={() => popover.setOpen(!popover.open)} className={active ? 'bg-hover' : ''}>
      {icon}{label}{active && <span aria-label="Filters active" className="h-1.5 w-1.5 rounded-full bg-focus-blue" />}
    </Button>
    {popover.open && <PopoverSurface popoverRef={popover.popoverRef} pos={popover.pos} portalTarget={popover.portalTarget} width={240} className="p-3">
      <div role="dialog" aria-label={label}>{children}</div>
    </PopoverSurface>}
  </>
}
