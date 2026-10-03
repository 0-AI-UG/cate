// The editor view: renders the session snapshot, binds Monaco to the file's
// buffer, and asks its user before destructive ops (switching away from or
// closing unsaved edits, where to Save As).

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronRight, Copy, Folders, Github, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { runtimeFor } from '@kernel/rpc/client'
import { isRpcError } from '@kernel/rpc/contract'
import { LoadingState, PanelCenteredState, getActiveTheme, subscribeTheme, useShortcutLabel } from '../../kernel/interaction'
import { clientUi, errorMessage, shortcutRegistry } from '@kernel/interaction'
import { clientStateFor, documentStoreFor } from '@client/document'
import { useClientState } from '../../client/document'
import { getClientSetting } from '../../kernel/settings'
import { onPanelShortcut, panelTypeOpening } from '@client/host'
import { type PanelViewProps } from '../../client/host/views'
import { openDroppedFiles } from '../../app'
import { pathDisplayName, pathKey, toRelativePath } from '@workspace/files/contract'
import { recordRecentFile } from '@workspace/files/client'
import { useFileViewsHost } from '../../workspace/files'
// Also brings the `vcs` capability into the runtime proxy's type.
import { boundWorktreeId } from '@workspace/repository/contract'
import { WorktreeSelector, useRepositoryUi, useWorktrees } from '../../workspace/repository'
import type { EditorOp, EditorSnapshot } from '@panels/editor/contract'
import { useBufferText, useTextContent } from './bufferText'
import { CodeEditor, revealLine } from './CodeEditor'
import { ConflictBanner, type ConflictAction } from './ConflictBanner'
import { confirmUnsaved, save, saveAs } from './editorActions'
import { besideTree } from './besideTree'
import { useEditorFont } from './editorSettings'
import { MarkdownPreview } from './MarkdownPreview'
import { MergeView } from './MergeView'
import { NavigationSidebar } from './NavigationSidebar'
import { isHtmlFile, openFileInBrowser } from './openInBrowser'
import type { monaco } from './monacoSetup'

const FilePreview = lazy(() => import('./FilePreview'))

type Reveal = { line: number; column?: number | null }

/** The last runtime reveal each panel applied on this client. */
const appliedReveals = new Map<string, number>()
/** Sidebar presentation per panel on this client. */
const sidebars = new Map<string, { visible: boolean; view: 'explorer' | 'search' }>()

export default function EditorView({ workspaceId, panelId, record, send: sendOp, snapshot, visible, focused }: PanelViewProps<EditorSnapshot, EditorOp>) {
  const send = sendOp as (op: EditorOp) => Promise<unknown>
  const font = useEditorFont()
  const shortcutLabel = useShortcutLabel()
  const fileViews = useFileViewsHost()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const pendingReveal = useRef<Reveal | null>(null)
  const [sidebar, setSidebarState] = useState(() => sidebars.get(panelId) ?? { visible: true, view: 'explorer' as const })
  const [focusSearch, setFocusSearch] = useState(0)
  const [background, setBackground] = useState(() => getActiveTheme().editor.colors?.['editor.background'] ?? 'var(--surface-1)')

  const filePath = snapshot?.filePath ?? null
  const isDraft = snapshot?.draft
  // The palette lists files this client opened, newest first.
  useEffect(() => {
    if (filePath && isDraft === false) recordRecentFile(workspaceId, filePath)
  }, [workspaceId, filePath, isDraft])
  const textual = !!filePath && !snapshot?.documentType
  const bufferPath = textual && !snapshot?.loading && !snapshot?.error ? filePath : null
  const { text, error: attachError } = useBufferText(workspaceId, bufferPath)
  const mode = snapshot?.mode ?? 'code'
  const markdown = useTextContent(mode === 'preview' && textual ? text : null)

  useEffect(() => subscribeTheme((theme) => setBackground(theme.editor.colors?.['editor.background'] ?? 'var(--surface-1)')), [])

  const setSidebar = (next: { visible: boolean; view: 'explorer' | 'search' }) => {
    sidebars.set(panelId, next)
    setSidebarState(next)
  }

  const run = useCallback(async (work: () => Promise<unknown>, failure: string) => {
    try {
      await work()
    } catch (err) {
      // A conflict shows in the banner; the snapshot already says so.
      if (!isRpcError(err, 'conflict')) clientUi().showError(errorMessage(err, failure))
    }
  }, [])

  // ---- reveals -------------------------------------------------------------

  const applyReveal = useCallback((reveal: Reveal) => {
    const editor = editorRef.current
    if (editor) revealLine(editor, reveal.line, reveal.column)
    else pendingReveal.current = reveal
  }, [])
  const onEditor = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null) => {
    editorRef.current = editor
    if (editor && pendingReveal.current) {
      revealLine(editor, pendingReveal.current.line, pendingReveal.current.column)
      pendingReveal.current = null
    }
  }, [])
  const runtimeReveal = snapshot?.reveal ?? null
  useEffect(() => {
    if (!runtimeReveal || appliedReveals.get(panelId) === runtimeReveal.seq) return
    appliedReveals.set(panelId, runtimeReveal.seq)
    applyReveal(runtimeReveal)
  }, [runtimeReveal, panelId, applyReveal])
  const hasRevealIntent = useClientState(workspaceId, (state) => state.intents.some((intent) => intent.panelId === panelId && intent.kind === 'reveal'))
  useEffect(() => {
    if (!hasRevealIntent) return
    const store = clientStateFor(workspaceId)
    if (!store) return
    let last: Reveal | null = null
    for (const intent of store.takeIntents(panelId)) {
      if (intent.kind === 'reveal') last = intent.data as Reveal
      else store.pushIntent({ panelId: intent.panelId, kind: intent.kind, data: intent.data })
    }
    if (last) {
      if (mode === 'preview' && !snapshot?.documentType) void send({ kind: 'setMode', mode: 'code' })
      applyReveal(last)
    }
  }, [hasRevealIntent, workspaceId, panelId, applyReveal, mode, send, snapshot?.documentType])

  useEffect(() => {
    if (focused && mode === 'code') editorRef.current?.focus()
  }, [focused, mode])

  // ---- actions -------------------------------------------------------------

  const title = record.title
  const doSave = useCallback(() => {
    if (!snapshot?.filePath) return
    void run(() => save(send, workspaceId, snapshot, title), 'Could not save the file.')
  }, [workspaceId, snapshot, title, run, send])

  const treeOnly = record.fields.treeOnly === true
  const setTreeOnly = useCallback((on: boolean) => {
    documentStoreFor(workspaceId)?.propose({ kind: 'updatePanel', id: panelId, patch: { fields: { treeOnly: on ? true : null } } })
  }, [workspaceId, panelId])

  const openFiles = useCallback(async (paths: string[], openMode?: 'dock' | 'canvas', reveal?: Reveal) => {
    if (openMode === 'canvas') {
      fileViews.openFiles(workspaceId, paths, 'canvas')
      return
    }
    // A tree-only panel opens files beside itself, or shows its editor.
    if (treeOnly && getClientSetting('filesTreeOpenFileIn') === 'beside') {
      const doc = documentStoreFor(workspaceId)?.getSnapshot()
      if (!doc) return
      const [first] = paths
      openDroppedFiles(workspaceId, paths, besideTree(doc, panelId), first && reveal ? { path: first, line: reveal.line, column: reveal.column ?? 1 } : null)
      return
    }
    const [next, ...rest] = paths
    if (rest.length) fileViews.openFiles(workspaceId, rest, 'dock')
    if (!next || !snapshot) return
    let discard = false
    if (next !== filePath) {
      const answer = await confirmUnsaved(send, workspaceId, snapshot, title)
      if (!answer) return
      discard = answer === 'discard'
    }
    if (treeOnly) setTreeOnly(false)
    await run(() => send({
      kind: 'openFile',
      path: next,
      ...(reveal ? { line: reveal.line, ...(reveal.column ? { column: reveal.column } : {}) } : {}),
      ...(discard ? { discard: true } : {}),
    }), 'Could not switch files.')
  }, [fileViews, workspaceId, panelId, snapshot, filePath, send, title, run, treeOnly, setTreeOnly])

  const worktrees = useWorktrees()
  const workspaceRoot = useRepositoryUi().root
  const switchWorktree = useCallback(async (worktreeId: string) => {
    if (!snapshot) return
    // A draft's text moves with it; a file's unsaved edits stay behind.
    const answer = snapshot.draft ? 'discard' : await confirmUnsaved(send, workspaceId, snapshot, title)
    if (!answer) return
    await run(() => send({ kind: 'switchWorktree', worktreeId: boundWorktreeId(worktreeId, workspaceRoot), ...(answer === 'discard' ? { discard: true } : {}) }), 'Could not switch the worktree.')
  }, [workspaceId, workspaceRoot, snapshot, send, title, run])

  const onConflict = (action: ConflictAction) => {
    const resolve = (resolution: 'reload' | 'keep' | 'merge') => send({ kind: 'resolveConflict', resolution })
    void run(async () => {
      switch (action) {
        case 'reload': return resolve('reload')
        case 'keepMine': return resolve('keep')
        case 'keepBoth': return resolve('merge')
        case 'viewDiff': return send({ kind: 'setMode', mode: 'merge' })
        case 'closeDiff': return send({ kind: 'setMode', mode: 'code' })
        case 'dismiss': return resolve('keep')
        case 'saveToRestore':
          await resolve('keep')
          if (snapshot?.filePath) await save(send, workspaceId, snapshot, title)
      }
    }, 'Could not resolve the conflict.')
  }

  const ui = clientUi()
  const openOnGitHub = () => {
    if (!filePath) return
    void run(async () => {
      const page = await runtimeFor(workspaceId).vcs.fileWebUrl({ path: filePath })
      if (page) ui.openExternal(page.url)
      else ui.showError('This file is not in a git repository with a GitHub origin.')
    }, 'Could not open this file on GitHub.')
  }
  const copyPath = (path: string | null) => {
    if (path && ui.writeClipboard) void run(() => ui.writeClipboard!(path), 'Could not copy the path.')
  }

  // The shortcuts the definition claims, from keys or a native menu pick.
  const runClaimed = (action: string | null): boolean => {
    if (action === 'saveFile') {
      doSave()
      return true
    }
    if (action === 'toggleFileExplorer' || action === 'toggleSearch') {
      const view = action === 'toggleSearch' ? 'search' : 'explorer'
      setSidebar({ visible: !(sidebar.visible && sidebar.view === view), view })
      if (view === 'search') setFocusSearch((n) => n + 1)
      return true
    }
    return false
  }
  const runClaimedRef = useRef(runClaimed)
  runClaimedRef.current = runClaimed
  useEffect(() => onPanelShortcut((ws, id, action) => ws === workspaceId && id === panelId && runClaimedRef.current(action)), [workspaceId, panelId])

  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    if (!runClaimed(shortcutRegistry().match(event))) return
    event.preventDefault()
    event.stopPropagation()
  }

  // A collapsed editor leaves the layout, so Monaco stops measuring and drawing.
  const editorVisible = !treeOnly || !(sidebar.visible && !!snapshot?.checkout)

  // ---- render --------------------------------------------------------------

  if (!snapshot) return <LoadingState label="Loading file" className="w-full h-full bg-surface-1 text-sm" />

  const { documentType, conflict, loading, dirty, connectedDraft, checkout, draft } = snapshot
  const error = snapshot.error ?? attachError
  const isMarkdown = !!filePath && /\.mdx?$/i.test(filePath)
  const root = checkout ?? ''
  const sidebarVisible = sidebar.visible && !!root
  // Sidebar only: the file's own path and actions are hidden.
  const shownFile = editorVisible ? filePath : null
  const notFound = !!error && /ENOENT|no such file|no longer exists/i.test(error)

  return (
    <div className="w-full h-full flex flex-col" onKeyDownCapture={onKeyDownCapture} data-dirty={dirty || undefined}>
      {conflict && <ConflictBanner kind={conflict} showDiff={mode === 'merge'} onAction={onConflict} />}
      <div className="relative h-10 shrink-0 border-b border-subtle" style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
        <div className="no-scrollbar h-full overflow-x-auto px-2 flex items-center gap-1 text-xs" data-worktree-room>
          <button
            onClick={() => copyPath(editorVisible ? filePath : root)}
            disabled={!(editorVisible ? filePath : root) || !ui.writeClipboard}
            className="min-w-0 flex-1 flex items-center gap-1 px-2 py-1 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            title={shownFile ?? root}
            aria-label="Copy path"
          >
            <span className={`${shownFile ? 'max-w-[40%]' : ''} truncate text-muted`}>{pathDisplayName(root) || 'Files'}</span>
            {shownFile && <><ChevronRight size={12} className="shrink-0 text-muted" /><span className="truncate text-primary">{draft ? title : toRelativePath(shownFile, root)}</span></>}
            {ui.writeClipboard && <Copy size={12} className="shrink-0" />}
          </button>
          {editorVisible && draft && <button className="shrink-0 rounded px-2 py-1 text-primary hover:bg-hover" onClick={() => void run(() => saveAs(send, workspaceId, snapshot, title), 'Could not save the file.')}>Save As…</button>}
          {root && (
            <div className="shrink-0 flex">
              <WorktreeSelector
                worktrees={worktrees}
                value={worktrees.find((worktree) => pathKey(worktree.path) === pathKey(root))?.id}
                onChange={switchWorktree}
                title="Files panel worktree"
              />
            </div>
          )}
          {editorVisible && connectedDraft && !connectedDraft.syncError && <span className="shrink-0 text-muted" title="Edits autosave to the file shared with your agent.">Shared with agent</span>}
          {editorVisible && connectedDraft?.syncError &&<button className="shrink-0 text-error" title={connectedDraft.syncError} onClick={doSave}>Save failed · Retry</button>}
          {editorVisible && isMarkdown && !draft && (
            <button
              onClick={() => void run(() => send({ kind: 'setMode', mode: mode === 'preview' ? 'code' : 'preview' }), 'Could not switch the view.')}
              className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'preview' ? 'bg-agent/15 text-agent hover:bg-agent/25' : 'bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary'}`}
              title={mode === 'preview' ? 'Show source' : 'Preview markdown'}
            >{mode === 'preview' ? 'Source' : 'Preview'}</button>
          )}
          {editorVisible && filePath && !draft && isHtmlFile(filePath) && panelTypeOpening('url') && (
            <button
              onClick={() => void run(() => openFileInBrowser(workspaceId, filePath, panelId), 'Could not open the file in a browser.')}
              className="shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary"
              title="Open in browser"
            >Open in browser</button>
          )}
          {editorVisible && <button onClick={openOnGitHub} disabled={!filePath || draft} className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40" title="Open on GitHub" aria-label="Open on GitHub"><Github size={14} /></button>}
          <button
            onClick={() => {
              if (editorVisible) setSidebar({ ...sidebar, visible: true })
              setTreeOnly(editorVisible)
            }}
            disabled={!root}
            className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            title={editorVisible ? 'Show only the file tree' : 'Show the editor next to the tree'}
            aria-label={editorVisible ? 'Show sidebar only' : 'Show editor'}
            aria-pressed={!editorVisible}
          >{editorVisible ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</button>
          <button
            onClick={() => setSidebar({ visible: !(sidebarVisible && sidebar.view === 'explorer'), view: 'explorer' })}
            disabled={!root}
            className={`shrink-0 p-1.5 rounded-md hover:bg-hover disabled:opacity-40 ${sidebarVisible && sidebar.view === 'explorer' ? 'text-primary bg-surface-3' : 'text-secondary'}`}
            title={shortcutLabel('toggleFileExplorer', sidebarVisible && sidebar.view === 'explorer' ? 'Hide files' : 'Show files')}
            aria-label="Files sidebar"
            aria-pressed={sidebarVisible && sidebar.view === 'explorer'}
          ><Folders size={15} /></button>
          <button
            onClick={() => {
              setSidebar({ visible: !(sidebarVisible && sidebar.view === 'search'), view: 'search' })
              setFocusSearch((n) => n + 1)
            }}
            disabled={!root}
            className={`shrink-0 p-1.5 rounded-md hover:bg-hover disabled:opacity-40 ${sidebarVisible && sidebar.view === 'search' ? 'text-primary bg-surface-3' : 'text-secondary'}`}
            title={shortcutLabel('toggleSearch', sidebarVisible && sidebar.view === 'search' ? 'Hide search' : 'Search in files')}
            aria-label="Search sidebar"
            aria-pressed={sidebarVisible && sidebar.view === 'search'}
          ><Search size={15} /></button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex" style={{ backgroundColor: background, '--file-explorer-bg': background } as CSSProperties}>
        <div
          aria-hidden={!editorVisible}
          className={`${editorVisible ? 'flex-1' : 'hidden'} min-w-0 relative overflow-hidden`}
        >
          {documentType && filePath && (
            <Suspense fallback={<LoadingState label="Loading preview" className="h-full" />}>
              <FilePreview workspaceId={workspaceId} filePath={filePath} />
            </Suspense>
          )}
          {textual && mode === 'merge' && conflict === 'changed' && filePath && (
            <MergeView workspaceId={workspaceId} filePath={filePath} text={text} font={font} />
          )}
          {textual && mode === 'preview' && filePath && <MarkdownPreview content={markdown} workspaceId={workspaceId} filePath={filePath} />}
          {textual && error && (
            <PanelCenteredState
              className="absolute inset-0 z-20 bg-surface-1 px-6"
              title={notFound ? 'File not found in this worktree' : 'Couldn’t open this file'}
              description={<span className="break-all text-secondary">{notFound
                ? `${filePath ? toRelativePath(filePath, root) : 'This file'} is not present here. Open a file from Files.`
                : error}</span>}
            />
          )}
          {textual && !error && (loading || !text) && <LoadingState label="Loading file" className="absolute inset-0 z-20 bg-surface-1 text-sm" />}
          {textual && filePath && (
            <CodeEditor panelId={panelId} filePath={filePath} text={text} font={font} hidden={mode !== 'code' || !!error} onEditor={onEditor} />
          )}
        </div>
        {root && (
          <NavigationSidebar
            workspaceId={workspaceId}
            panelId={panelId}
            root={root}
            view={sidebar.view}
            visible={sidebarVisible}
            fill={!editorVisible}
            focusToken={focusSearch}
            focusInput={sidebarVisible && visible && focused}
            onHide={() => setSidebar({ ...sidebar, visible: false })}
            onOpenFiles={(paths, openMode, reveal) => { void openFiles(paths, openMode, reveal) }}
          />
        )}
      </div>
    </div>
  )
}
