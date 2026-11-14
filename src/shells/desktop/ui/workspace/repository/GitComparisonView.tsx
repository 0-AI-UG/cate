import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Settings2, ChevronsDownUp, ChevronDown, ChevronRight, FileSearch, Minus, Plus, RefreshCw, Trash } from 'lucide-react'
import { clientUi, errorMessage } from '@kernel/interaction'
import { pathDisplayName } from '@workspace/files/contract'
import type { ReviewRequest } from '@workspace/repository/client'
import type { GitChangedFile, GitComparisonResult, GitFileDiff, GitFileContent } from '@workspace/repository/contract'
import { useRuntime } from '../../kernel/rpc'
import { Button, IconButton, LoadingState } from '../../kernel/interaction'
import { useFileViewsHost } from '../files'
import { useGitStatus } from './gitStatus'
import { repositoryReadCacheFor } from './readCache'
import { GitDiff } from './GitDiff'

/** General Git comparisons stay in the repository overlay. Only expanded files load diffs. */
export function GitComparisonView({ workspaceId, request, onBack, onOpenFile }: {
  workspaceId: string
  request: ReviewRequest
  onBack?(): void
  onOpenFile?(): void
}) {
  const runtime = useRuntime(workspaceId)
  const cache = runtime ? repositoryReadCacheFor(runtime) : null
  const status = useGitStatus(workspaceId, request.repoPath)
  const filesHost = useFileViewsHost()
  const [result, setResult] = useState<GitComparisonResult | null>(() => cache?.peek('compare', { cwd: request.repoPath, spec: { ...request.spec, ignoreWhitespace: request.spec.ignoreWhitespace ?? false } }) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const [expanded, setExpanded] = useState(() => new Set(request.focusedFile ? [request.focusedFile] : []))
  const [busy, setBusy] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [split, setSplit] = useState(false)
  const [wordDiff, setWordDiff] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(request.spec.ignoreWhitespace ?? false)
  const [fullFile, setFullFile] = useState(false)
  const specKey = JSON.stringify({ ...request.spec, ignoreWhitespace })
  useEffect(() => {
    if (!cache || status.loading) return
    let live = true
    const args = { cwd: request.repoPath, spec: JSON.parse(specKey) }
    const cached = cache.peek('compare', args)
    if (cached) setResult(cached)
    setLoading(true)
    setError(null)
    void cache.read('compare', args, `${revision}:${status.revision}`).then((comparison) => {
      if (live) setResult(comparison)
    }).catch((cause) => { if (live) setError(errorMessage(cause, 'Could not load Git comparison')) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [cache, request.repoPath, specKey, revision, status.revision, status.loading])
  const mutate = async (file: GitChangedFile, action: 'stage' | 'unstage' | 'discard') => {
    if (!runtime || busy) return
    if (action === 'discard' && !await clientUi().confirm(file.untracked ? `Delete untracked file ${file.path}?` : `Discard working changes to ${file.path}? Staged changes will be preserved.`)) return
    setBusy(true)
    setError(null)
    try {
      if (action === 'discard') {
        if (file.untracked) await runtime.file.trash({ path: absolutePath(request.repoPath, file.path) })
        else await runtime.vcs.discardFile({ cwd: request.repoPath, path: file.path })
      } else await runtime.vcs[action]({ cwd: request.repoPath, path: file.path })
      setRevision((value) => value + 1)
    } catch (cause) { setError(errorMessage(cause, 'Could not update Git changes')) }
    finally { setBusy(false) }
  }
  const working = request.spec.kind === 'uncommitted' || request.spec.kind === 'unstaged'
  const toggle = (path: string) => setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next })
  const openDisplayMenu = async () => {
    if (optionsOpen) return
    const options = [
      ['split', 'Split diff', split, setSplit],
      ['word', 'Word differences', wordDiff, setWordDiff],
      ['wrap', 'Wrap lines', wrap, setWrap],
      ['whitespace', 'Ignore whitespace', ignoreWhitespace, setIgnoreWhitespace],
      ['context', 'Full file context', fullFile, setFullFile],
    ] as const
    setOptionsOpen(true)
    try {
      const choice = await clientUi().showContextMenu([
        ...options.map(([id, label, checked]) => ({ id, label, type: 'checkbox' as const, checked })),
        { type: 'separator' },
        { id: 'copy', label: 'Copy apply command', enabled: !!result?.files.length && !busy && !loading },
      ])
      const option = options.find(([id]) => id === choice)
      if (option) option[3](!option[2])
      if (choice === 'copy' && runtime) {
        setBusy(true)
        try {
          const command = await runtime.vcs.applyCommand({ cwd: request.repoPath, spec: JSON.parse(specKey) })
          await clientUi().writeClipboard?.(command)
        } catch (cause) { setError(errorMessage(cause, 'Could not copy comparison')) }
        finally { setBusy(false) }
      }
    } finally { setOptionsOpen(false) }
  }
  return <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-subtle text-xs">
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-3 text-[13px]">
      {onBack && <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft size={14} />Working changes</Button>}
      <span className="min-w-0 flex-1 truncate font-semibold">{request.title ?? (request.spec.kind === 'branch' ? `${request.spec.base} → ${request.spec.target}` : request.spec.kind === 'commit' ? `Commit ${request.spec.commit.slice(0, 8)}` : request.spec.kind === 'staged' ? 'Staged changes' : request.spec.kind === 'unstaged' ? 'Working changes' : 'Changes')}</span>
      {result && <><span className="min-w-6 rounded-full bg-surface-3 px-2 py-0.5 text-center text-[11px] font-medium text-secondary tabular-nums">{result.files.length}</span><span className="flex shrink-0 items-center gap-2 text-xs tabular-nums"><span className="text-diff-add">+{result.additions}</span><span className="text-diff-del">−{result.deletions}</span></span></>}
      <IconButton label="Collapse all" disabled={!expanded.size} onClick={() => setExpanded(new Set())}><ChevronsDownUp size={14} /></IconButton>
      <Button variant="ghost" size="sm" aria-haspopup="menu" aria-expanded={optionsOpen} onClick={() => void openDisplayMenu()}><Settings2 size={14} />Display</Button>
      <IconButton label="Refresh changes" loading={loading} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /></IconButton>
    </div>
    {error && <p role="alert" className="shrink-0 p-3 text-error">{error}</p>}
    {loading && !result ? <LoadingState label="Loading Git comparison" className="flex-1" /> : <div data-review-scroll data-git-diff-scroll className="min-h-0 flex-1 overflow-y-auto">
      {!result?.files.length && !error && <p className="flex h-full min-h-32 items-center justify-center p-6 text-muted">{working ? 'Working tree clean.' : 'No changes in this comparison.'}</p>}
      {result?.files.map((file) => <section key={file.path} className="border-b border-subtle">
        <div className="group flex items-center gap-3 px-4 py-3 text-[13px] hover:bg-hover">
          <button aria-label={`${expanded.has(file.path) ? 'Collapse' : 'Expand'} ${file.path}`} aria-expanded={expanded.has(file.path)} onClick={() => toggle(file.path)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            {expanded.has(file.path) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}<span className="min-w-0 flex-1 truncate font-medium text-primary" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{pathDisplayName(file.path)}{file.path.includes('/') && <span className="ml-2 font-normal text-muted">{file.path.slice(0, file.path.lastIndexOf('/'))}</span>}</span>
          </button>
          {file.staged && <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-secondary">{file.working ? 'Partly staged' : 'Staged'}</span>}
          {file.untracked && <span className="text-[10px] text-muted">New</span>}
          <span className="text-diff-add">+{file.additions ?? '–'}</span><span className="text-diff-del">−{file.deletions ?? '–'}</span>
          <Button variant="ghost" size="sm" aria-label={`Open ${file.path}`} title="Open working file" disabled={file.status === 'deleted'} onClick={() => { filesHost.openFiles(workspaceId, [absolutePath(request.repoPath, file.path)], 'dock'); onOpenFile?.() }}><FileSearch size={14} /></Button>
          {working && file.working && <>
            <Button variant="ghost" size="sm" aria-label={`Stage ${file.path}`} title="Stage file" disabled={busy || loading} onClick={() => void mutate(file, 'stage')}><Plus size={14} /></Button>
            <Button variant="ghost" size="sm" aria-label={`Discard ${file.path}`} title="Discard working changes" disabled={busy || loading} onClick={() => void mutate(file, 'discard')}><Trash size={14} /></Button>
          </>}
          {file.staged && <Button variant="ghost" size="sm" aria-label={`Unstage ${file.path}`} title="Unstage file" disabled={busy || loading} onClick={() => void mutate(file, 'unstage')}><Minus size={14} /></Button>}
        </div>
        {expanded.has(file.path) && (working && file.staged && file.working ? ['staged', 'unstaged'] as const : [null]).map((part, index) => <div key={part ?? 'all'}>
          {part && <div className="border-y border-subtle bg-surface-2 px-3 py-1.5 text-[11px] text-secondary">{part === 'staged' ? 'Staged changes' : 'Working changes'}</div>}
          <FileDiffBody workspaceId={workspaceId} cwd={request.repoPath} path={file.path} oldPath={file.oldPath} binary={file.binary}
            specKey={part ? JSON.stringify({ kind: part, ignoreWhitespace }) : specKey} revision={`${revision}:${status.revision}`} split={split} wordDiff={wordDiff} wrap={wrap} fullFile={fullFile} ready={!status.loading} focused={index === 0 && request.focusedFile === file.path} />
        </div>)}
      </section>)}
    </div>}
  </div>
}

function absolutePath(root: string, path: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[/\\]+$/, '')}${separator}${path}`
}

function FileDiffBody({ workspaceId, cwd, path, oldPath, binary, specKey, revision, split, wordDiff, wrap, fullFile, ready, focused }: {
  workspaceId: string; cwd: string; path: string; oldPath?: string; binary: boolean; specKey: string; revision: string
  split: boolean; wordDiff: boolean; wrap: boolean; fullFile: boolean; ready: boolean; focused: boolean
}) {
  const runtime = useRuntime(workspaceId)
  const cache = runtime ? repositoryReadCacheFor(runtime) : null
  const root = useRef<HTMLDivElement>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(() => cache?.peek('fileDiff', { cwd, spec: JSON.parse(specKey), path, contextLines: fullFile ? 999_999 : 3, allowLarge: false }) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [allowLarge, setAllowLarge] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => { if (focused) root.current?.scrollIntoView?.({ block: 'start' }) }, [focused])
  useEffect(() => {
    if (!cache || binary || !ready) return
    let live = true
    const args = { cwd, spec: JSON.parse(specKey), path, contextLines: fullFile ? 999_999 : 3, allowLarge }
    setDiff(cache.peek('fileDiff', args) ?? null); setError(null)
    void cache.read('fileDiff', args, `${revision}:${attempt}`).then(
      (value) => { if (live) setDiff(value) },
      (cause) => { if (live) setError(errorMessage(cause, 'Could not load file diff')) },
    )
    return () => { live = false }
  }, [cache, cwd, path, binary, ready, specKey, revision, fullFile, allowLarge, attempt])
  return <div ref={root} className="overflow-x-auto font-mono text-[11px] leading-[1.45]">
    {binary ? <ImageDiff workspaceId={workspaceId} cwd={cwd} path={path} oldPath={oldPath} specKey={specKey} revision={revision} ready={ready} /> : error ? <p role="alert" className="p-3 text-error">{error} <button className="underline" onClick={() => setAttempt((value) => value + 1)}>Retry</button></p>
      : !diff ? <LoadingState label="Loading file diff" className="p-4" />
      : diff.binary ? <p className="p-4 font-sans text-muted">Binary file changed.</p>
      : diff.tooLarge ? <Button className="m-4" onClick={() => setAllowLarge(true)}>Load large diff</Button>
      : !diff.hunks.length ? <p className="p-4 font-sans text-muted">No net difference in this comparison. Staged and working changes may cancel each other.</p>
      : <div className={wrap ? 'w-full min-w-0 whitespace-pre-wrap break-all' : 'w-max min-w-full whitespace-pre'}><GitDiff hunks={diff.hunks} split={split} wordDiff={wordDiff} wrap={wrap} /></div>}
  </div>
}

/** Binary image sides are requested only when their file is expanded. */
function ImageDiff({ workspaceId, cwd, path, oldPath, specKey, revision, ready }: {
  workspaceId: string; cwd: string; path: string; oldPath?: string; specKey: string; revision: string; ready: boolean
}) {
  const runtime = useRuntime(workspaceId)
  const cache = runtime ? repositoryReadCacheFor(runtime) : null
  const mime = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' } as Record<string, string>)[path.split('.').pop()?.toLowerCase() ?? '']
  const [sides, setSides] = useState<GitFileContent[] | null>(() => {
    const cached = (['old', 'new'] as const).map((side) => cache?.peek('fileContent', { cwd, spec: JSON.parse(specKey), path: side === 'old' ? oldPath ?? path : path, side }))
    return cached.every((side) => side !== undefined) ? cached as GitFileContent[] : null
  })
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!cache || !mime || !ready) return
    let live = true
    const args = (['old', 'new'] as const).map((side) => ({ cwd, spec: JSON.parse(specKey), path: side === 'old' ? oldPath ?? path : path, side }))
    const cached = args.map((args) => cache.peek('fileContent', args))
    setSides(cached.every((side) => side !== undefined) ? cached as GitFileContent[] : null); setError(null)
    void Promise.all(args.map((args) => cache.read('fileContent', args, revision)))
      .then((value) => { if (live) setSides(value) }, (cause) => { if (live) setError(errorMessage(cause, 'Could not load image')) })
    return () => { live = false }
  }, [cache, cwd, path, oldPath, mime, ready, specKey, revision])
  if (!mime) return <p className="p-4 font-sans text-muted">Binary file changed.</p>
  if (error) return <p role="alert" className="p-4 text-error">{error}</p>
  if (!sides) return <LoadingState label="Loading image comparison" className="p-4" />
  return <div className="grid grid-cols-2 gap-3 p-3 font-sans">{sides.map((content, index) => <figure key={index} className="min-w-0">
    <figcaption className="mb-2 text-muted">{index === 0 ? 'Before' : 'After'}</figcaption>
    {!content.exists ? <p className="text-muted">File absent</p> : !content.base64 ? <p className="text-muted">Image too large to preview</p> : <img alt={`${index === 0 ? 'Before' : 'After'} ${path}`} src={`data:${mime};base64,${content.base64}`} className="max-h-96 max-w-full object-contain" />}
  </figure>)}</div>
}
