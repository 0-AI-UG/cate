import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Plus, MagnifyingGlass, Trash } from '@phosphor-icons/react'
import { CanvasToolbarButton } from './CanvasToolbarButton'
import { Spinner } from '../ui/Spinner'
import { T3Logo } from '../ui/T3Logo'
import { useDismissableLayer } from '../ui/Popover'
import { useAppStore } from '../stores/appStore'
import { useCanvasStoreApi } from '../stores/CanvasStoreContext'
import { inheritedWorktreeFromSelection, type InheritedWorktree } from '../lib/inheritWorktree'
import type { T3Conversation } from '../../shared/t3Agent'

export function T3ConversationMenu({ canvasPanelId, workspaceId, rootPath, tooltipPlacement, menuSide, onOpenChange }: {
  canvasPanelId: string; workspaceId: string; rootPath: string
  tooltipPlacement: 'top' | 'right'; menuSide: 'up' | 'right'
  onOpenChange: (open: boolean) => void
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const canvasApi = useCanvasStoreApi()
  const [checkout, setCheckout] = useState<InheritedWorktree>({})
  const cwd = checkout.cwd ?? rootPath
  const [search, setSearch] = useState('')
  const [threads, setThreads] = useState<T3Conversation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const close = () => { setPosition(null); onOpenChange(false) }
  useDismissableLayer({ open: !!position, contentRef: content, triggerRefs: [trigger], onDismiss: close })
  useEffect(() => {
    if (!position || !cwd) return
    let cancelled = false
    setLoading(true); setError(''); setThreads([])
    void window.electronAPI.agentHarnessListConversations({ workspaceId, cwd }).then((result) => {
      if (cancelled) return
      if ('error' in result) setError(result.error)
      else setThreads(result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    }).catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load conversations.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [position, cwd, workspaceId])
  const create = (thread?: T3Conversation) => {
    const app = useAppStore.getState()
    close()
    const id = app.createAgent(workspaceId, undefined, { target: 'canvas', canvasPanelId }, cwd, checkout.worktreeId, thread?.id)
    if (thread) app.updatePanelTitleFromAgent(workspaceId, id, thread.title)
  }
  const remove = async (thread: T3Conversation) => {
    setDeleting(thread.id)
    setError('')
    try {
      const result = await window.electronAPI.agentHarnessDeleteConversation({ workspaceId, cwd, threadId: thread.id })
      if ('error' in result) { setError(result.error); return }
      setThreads((current) => current.filter((item) => item.id !== thread.id))
      setConfirmDelete(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not delete conversation.') }
    finally { setDeleting(null) }
  }
  const filtered = threads.filter((thread) => thread.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  return <>
    <CanvasToolbarButton ref={trigger} active={!!position} label="T3 Code conversations" tooltipPlacement={tooltipPlacement} size="panel" onClick={() => {
      if (position) { close(); return }
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const workspace = useAppStore.getState().workspaces.find((ws) => ws.id === workspaceId)
      const inherited = inheritedWorktreeFromSelection(canvasApi.getState(), workspace?.panels, workspace?.worktrees)
      setCheckout({ ...inherited, cwd: inherited.cwd ?? workspace?.worktrees?.find((wt) => wt.id === inherited.worktreeId)?.path })
      setSearch('')
      setConfirmDelete(null)
      setPosition({ left: Math.max(8, Math.min(menuSide === 'right' ? rect.right + 8 : rect.left + rect.width / 2 - 110, window.innerWidth - 228)), bottom: Math.max(8, menuSide === 'right' ? window.innerHeight - rect.bottom : window.innerHeight - rect.top + 10) })
      onOpenChange(true)
    }}><T3Logo size={18} /></CanvasToolbarButton>
    {position && createPortal(<div ref={content} role="dialog" aria-label="T3 Code conversations"
      className="fixed z-[1000] flex w-[220px] max-w-[calc(100vw-16px)] flex-col rounded-2xl border border-subtle shadow-xl py-1.5 text-xs"
      style={{ ...position, maxHeight: `calc(100vh - ${position.bottom + 8}px)`, background: 'color-mix(in srgb, var(--surface-0) 80%, transparent)', backdropFilter: 'blur(24px) saturate(1.5)', WebkitBackdropFilter: 'blur(24px) saturate(1.5)' }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className="px-2.5 pt-0.5 pb-1 text-[11px] font-medium text-muted select-none">T3 Code</div>
      <div className="mx-1 mb-1 flex items-center gap-2 rounded-lg bg-surface-3 px-1.5">
        <MagnifyingGlass size={13} className="shrink-0 text-muted" />
        <input aria-label="Search conversations" placeholder="Search conversations…" value={search} onChange={(e) => setSearch(e.target.value)} className="h-[26px] min-w-0 w-full bg-transparent text-[12px] text-primary outline-none placeholder:text-muted" />
      </div>
      <div className="min-h-0 overflow-y-auto">
        {error && <p role="alert" className="px-2.5 py-2 text-[11px] text-red-400">{error}</p>}
        {loading ? <div className="flex justify-center px-2.5 py-3"><Spinner size={16} label="Loading conversations" className="text-muted" /></div> : filtered.length === 0 ? <p className="px-2.5 py-3 text-[11px] text-muted">{search ? 'No matching conversations.' : 'No saved conversations.'}</p> : filtered.map((thread) => <div key={thread.id} className="group mx-1 rounded-lg hover:bg-surface-4">
          {confirmDelete === thread.id ? <div className="px-1.5 py-1 text-[11px]">
            <p className="text-secondary">Delete “{thread.title}”?</p>
            <div className="flex gap-3 py-1"><button disabled={!!deleting} onClick={() => void remove(thread)} className="text-red-400 disabled:opacity-50">{deleting === thread.id ? <Spinner size={12} label="Deleting conversation" /> : 'Delete'}</button><button disabled={!!deleting} onClick={() => setConfirmDelete(null)} className="text-muted">Cancel</button></div>
          </div> : <div className="flex items-center">
            <button onClick={() => create(thread)} className="min-w-0 flex flex-1 items-center gap-2 h-[26px] px-1.5 text-[12px] text-secondary hover:text-primary transition-colors" title={thread.title}><T3Logo size={13} className="shrink-0 text-muted" /><span className="truncate">{thread.title}</span></button>
            <button aria-label={`Delete ${thread.title}`} disabled={!!deleting} onClick={() => setConfirmDelete(thread.id)} className="p-1.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-400"><Trash size={12} /></button>
          </div>}
        </div>)}
      </div>
      <div className="my-1 h-px bg-surface-5 mx-2.5 shrink-0" />
      <button disabled={!cwd} onClick={() => create()} className="mx-1 w-[calc(100%-0.5rem)] flex shrink-0 items-center gap-2 h-[26px] px-1.5 rounded-lg text-[12px] text-secondary hover:text-primary hover:bg-surface-4 transition-colors disabled:opacity-40"><Plus size={13} className="shrink-0" />New conversation</button>
    </div>, document.body)}
  </>
}
