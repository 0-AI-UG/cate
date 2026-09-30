// The editor view: renders the session snapshot, binds Monaco to the file's
// buffer, and asks its user before destructive ops (switching away from or
// closing unsaved edits, where to Save As).

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { ChevronDown, ChevronRight, Copy, ExternalLink, Folders, Github, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import { isRpcError } from '@kernel/rpc/contract'
import {
  LoadingState,
  Modal,
  NodePopover,
  PanelCenteredState,
  btn,
  clientUi,
  errorMessage,
  getActiveTheme,
  inputCls,
  shortcutRegistry,
  subscribeTheme,
  useNodePopover,
  useShortcutLabel,
} from '@kernel/ui'
import type { FileApp } from '@kernel/ui/contract'
import { clientHas } from '@client/connections'
import { clientStateFor } from '@client/document'
import { useClientState } from '@client/document/ui'
import { onPanelShortcut, type PanelViewProps } from '@client/host'
import { pathDisplayName, toRelativePath } from '@workspace/files/contract'
import { recordRecentFile } from '@workspace/files/client'
import { useFileViewsHost } from '@workspace/files/ui'
import { isEditorDraft } from '@workspace/relations/contract'
import type { EditorOp, EditorSnapshot } from '../contract'
import { useBufferText, useTextContent } from './bufferText'
import { CodeEditor, revealLine } from './CodeEditor'
import { ConflictBanner, type ConflictAction } from './ConflictBanner'
import { confirmUnsaved, save, saveAs, type PathPrompt } from './editorActions'
import { useEditorFont } from './editorSettings'
import { MarkdownPreview } from './MarkdownPreview'
import { MergeView } from './MergeView'
import { NavigationSidebar } from './NavigationSidebar'
import type { monaco } from './monacoSetup'

const FilePreview = lazy(() => import('./FilePreview'))

type Reveal = { line: number; column?: number | null }

/** The last runtime reveal each panel applied on this client. */
const appliedReveals = new Map<string, number>()
/** Sidebar presentation per panel on this client. */
const sidebars = new Map<string, { visible: boolean; view: 'explorer' | 'search' }>()

function usePathPrompt(): [PathPrompt, JSX.Element | null] {
  const [request, setRequest] = useState<{ title: string; value: string; resolve: (value: string | null) => void } | null>(null)
  const prompt = useCallback<PathPrompt>(({ title, initial }) => new Promise((resolve) => setRequest({ title, value: initial, resolve })), [])
  const finish = (value: string | null) => {
    request?.resolve(value)
    setRequest(null)
  }
  const element = request && (
    <Modal title={request.title} onClose={() => finish(null)} width={420}>
      <form className="flex flex-col gap-3 p-4" onSubmit={(event) => { event.preventDefault(); finish(request.value) }}>
        <input
          autoFocus
          aria-label="File path"
          className={inputCls}
          value={request.value}
          onChange={(event) => setRequest({ ...request, value: event.target.value })}
        />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn.secondary} onClick={() => finish(null)}>Cancel</button>
          <button type="submit" className={btn.primary}>Save</button>
        </div>
      </form>
    </Modal>
  )
  return [prompt, element]
}

export default function EditorView({ workspaceId, panelId, record, send: sendOp, snapshot, visible, focused }: PanelViewProps<EditorSnapshot, EditorOp>) {
  const send = sendOp as (op: EditorOp) => Promise<unknown>
  const font = useEditorFont()
  const shortcutLabel = useShortcutLabel()
  const fileViews = useFileViewsHost()
  const [prompt, promptElement] = usePathPrompt()
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const pendingReveal = useRef<Reveal | null>(null)
  const [sidebar, setSidebarState] = useState(() => sidebars.get(panelId) ?? { visible: true, view: 'explorer' as const })
  const [editorCollapsed, setEditorCollapsed] = useState(false)
  const [focusSearch, setFocusSearch] = useState(0)
  const [openApps, setOpenApps] = useState<FileApp[] | null>(null)
  const [background, setBackground] = useState(() => getActiveTheme().editor.colors?.['editor.background'] ?? 'var(--surface-1)')
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const openMenu = useNodePopover(openButtonRef, (rect) => ({ left: Math.max(8, Math.min(rect.right - 224, window.innerWidth - 232)), gap: 6, height: 150 }))

  const filePath = snapshot?.filePath ?? null
  // The palette lists files this client opened, newest first.
  useEffect(() => {
    if (filePath && !isEditorDraft(filePath)) recordRecentFile(workspaceId, filePath)
  }, [workspaceId, filePath])
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
    if (!filePath) return
    void run(() => save(send, filePath, title, prompt), 'Could not save the file.')
  }, [filePath, title, prompt, run, send])

  const openFiles = useCallback(async (paths: string[], openMode?: 'dock' | 'canvas', reveal?: Reveal) => {
    if (openMode === 'canvas') {
      fileViews.openFiles(workspaceId, paths, 'canvas')
      return
    }
    const [next, ...rest] = paths
    if (rest.length) fileViews.openFiles(workspaceId, rest, 'dock')
    if (!next || !snapshot) return
    let discard = false
    if (next !== filePath) {
      const answer = await confirmUnsaved(send, snapshot, title, prompt)
      if (!answer) return
      discard = answer === 'discard'
    }
    await run(() => send({
      kind: 'openFile',
      path: next,
      ...(reveal ? { line: reveal.line, ...(reveal.column ? { column: reveal.column } : {}) } : {}),
      ...(discard ? { discard: true } : {}),
    }), 'Could not switch files.')
  }, [fileViews, workspaceId, snapshot, filePath, send, title, prompt, run])

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
          if (filePath) await save(send, filePath, title, prompt)
      }
    }, 'Could not resolve the conflict.')
  }

  const osFiles = clientHas('osFiles')
  const ui = clientUi()
  const openOutside = (target: 'default' | 'folder' | 'github' | { appId: string }) => {
    if (!filePath) return
    void run(async () => {
      if (target === 'folder') await ui.revealFile?.(filePath, workspaceId)
      else if (target === 'github') await ui.openFileOnGitHub?.(filePath, workspaceId)
      else await ui.openFile?.(filePath, workspaceId, target === 'default' ? undefined : target.appId)
    }, 'Could not open this file.')
  }
  const copyPath = () => {
    if (filePath && ui.writeClipboard) void run(() => ui.writeClipboard!(filePath), 'Could not copy the path.')
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

  // ---- render --------------------------------------------------------------

  if (!snapshot) return <LoadingState label="Loading file…" className="w-full h-full bg-surface-1 text-sm" />

  const { documentType, conflict, loading, dirty, connectedDraft, checkout } = snapshot
  const error = snapshot.error ?? attachError
  const draft = isEditorDraft(filePath ?? undefined)
  const isMarkdown = !!filePath && /\.mdx?$/i.test(filePath)
  const root = checkout ?? ''
  const sidebarVisible = sidebar.visible && !!root
  const editorVisible = !editorCollapsed || !sidebarVisible
  const notFound = !!error && /ENOENT|no such file|no longer exists/i.test(error)

  return (
    <div className="w-full h-full flex flex-col" onKeyDownCapture={onKeyDownCapture} data-dirty={dirty || undefined}>
      {conflict && <ConflictBanner kind={conflict} showDiff={mode === 'merge'} onAction={onConflict} />}
      <div className="relative h-10 shrink-0 border-b border-subtle" style={{ backgroundColor: 'var(--node-chrome-bg, var(--surface-1))' }}>
        <div className="no-scrollbar h-full overflow-x-auto px-2 flex items-center gap-1 text-xs">
          <button
            onClick={copyPath}
            disabled={!filePath || !ui.writeClipboard}
            className="min-w-0 flex-1 flex items-center gap-1 px-2 py-1 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            title={filePath ?? root}
            aria-label="Copy path"
          >
            <span className={`${filePath ? 'max-w-[40%]' : ''} truncate text-muted`}>{pathDisplayName(root) || 'Files'}</span>
            {filePath && <><ChevronRight size={12} className="shrink-0 text-muted" /><span className="truncate text-primary">{draft ? title : toRelativePath(filePath, root)}</span></>}
            {ui.writeClipboard && <Copy size={12} className="shrink-0" />}
          </button>
          {connectedDraft && <span className="shrink-0 text-muted" title="Edits autosave to the file shared with your agent.">Shared with agent</span>}
          {draft && <button className="shrink-0 rounded px-2 py-1 text-primary hover:bg-hover" onClick={() => filePath && void run(() => saveAs(send, filePath, title, prompt), 'Could not save the file.')}>Save As…</button>}
          {connectedDraft?.syncError && <button className="shrink-0 text-error" title={connectedDraft.syncError} onClick={doSave}>Save failed · Retry</button>}
          {isMarkdown && !draft && (
            <button
              onClick={() => void run(() => send({ kind: 'setMode', mode: mode === 'preview' ? 'code' : 'preview' }), 'Could not switch the view.')}
              className={`shrink-0 px-2 py-1 rounded-md text-xs font-medium transition-colors ${mode === 'preview' ? 'bg-agent/15 text-agent hover:bg-agent/25' : 'bg-surface-3 text-secondary hover:bg-surface-4 hover:text-primary'}`}
              title={mode === 'preview' ? 'Show source' : 'Preview markdown'}
            >{mode === 'preview' ? 'Source' : 'Preview'}</button>
          )}
          {osFiles && (
            <>
              <button onClick={() => openOutside('github')} disabled={!filePath} className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40" title="Open on GitHub"><Github size={14} /></button>
              <button
                ref={openButtonRef}
                onClick={() => {
                  if (!openMenu.open && openApps === null) void ui.fileApps?.().then(setOpenApps, () => setOpenApps([]))
                  openMenu.setOpen(!openMenu.open)
                }}
                aria-expanded={openMenu.open}
                disabled={!filePath}
                className="shrink-0 flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-strong text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
                title="Open in another app"
              ><ExternalLink size={13} /><span>Open</span><ChevronDown size={11} /></button>
            </>
          )}
          <button
            onClick={() => {
              if (editorVisible) setSidebar({ ...sidebar, visible: true })
              setEditorCollapsed(editorVisible)
            }}
            disabled={!root}
            className="shrink-0 p-1.5 rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
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
      {openMenu.open && (
        <NodePopover popoverRef={openMenu.popoverRef} pos={openMenu.pos} portalTarget={openMenu.portalTarget} width={224} bodyClassName="p-1.5 !rounded-2xl !border-subtle !bg-surface-3 !shadow-lg">
          <div onKeyDown={(event) => event.stopPropagation()} className="flex flex-col gap-0.5">
            {(openApps ?? []).map((app) => (
              <button key={app.id} onClick={() => { openMenu.setOpen(false); openOutside({ appId: app.id }) }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-primary hover:bg-hover">
                {app.icon ? <img src={app.icon} alt="" className="w-4 h-4 object-contain" /> : <ExternalLink size={16} />}{app.name}
              </button>
            ))}
            {!!openApps?.length && <div className="my-1 border-t border-subtle" />}
            {([
              ['default', 'Open in Default App', ExternalLink],
              ['folder', 'Show in File Explorer', Folders],
              ['github', 'Open on GitHub', Github],
            ] as const).map(([id, label, Icon]) => (
              <button key={id} onClick={() => { openMenu.setOpen(false); openOutside(id) }} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] text-primary hover:bg-hover focus-visible:bg-hover">
                <Icon size={16} className="text-muted" />{label}
              </button>
            ))}
          </div>
        </NodePopover>
      )}
      <div className="flex-1 min-h-0 flex" style={{ backgroundColor: background, '--file-explorer-bg': background } as CSSProperties}>
        <div className={`${editorVisible ? 'flex-1' : 'hidden'} min-w-0 relative`}>
          {documentType && filePath && (
            <Suspense fallback={<LoadingState label="Loading preview…" className="h-full" />}>
              <FilePreview workspaceId={workspaceId} filePath={filePath} />
            </Suspense>
          )}
          {textual && mode === 'merge' && conflict === 'changed' && filePath && (
            <MergeView workspaceId={workspaceId} filePath={filePath} text={text} font={font} />
          )}
          {textual && mode === 'preview' && <MarkdownPreview content={markdown} />}
          {textual && error && (
            <PanelCenteredState
              className="absolute inset-0 z-20 bg-surface-1 px-6"
              title={notFound ? 'File not found in this worktree' : 'Couldn’t open this file'}
              description={<span className="break-all text-secondary">{notFound
                ? `${filePath ? toRelativePath(filePath, root) : 'This file'} is not present here. Open a file from Files.`
                : error}</span>}
            />
          )}
          {textual && !error && (loading || !text) && <LoadingState label="Loading file…" className="absolute inset-0 z-20 bg-surface-1 text-sm" />}
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
      {promptElement}
    </div>
  )
}
