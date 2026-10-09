// The conversations menu (canvas toolbar): search a checkout's saved T3
// conversations, open one or a new one in a new chat panel, rename or delete.

import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { ActionId } from '@kernel/interaction/contract'
import { Plus, Search as MagnifyingGlass, Trash, Pencil as PencilSimple } from 'lucide-react'
import { Spinner, T3Logo, Tooltip, useDismissableLayer } from '../../kernel/interaction'
import { errorMessage } from '@kernel/interaction'
import type { T3Conversation } from '@services/t3/contract'
import type { T3ConversationSource } from '@services/t3/client'

/** What the menu works on, decided when it opens (the checkout of the current
 *  selection). */
export interface T3ConversationMenuTarget {
  conversations: T3ConversationSource
  /** Opens `thread`, or a new conversation, in a new chat panel. */
  open(thread: T3Conversation | undefined): void
}

export interface T3ConversationMenuTriggerProps {
  ref: RefObject<HTMLButtonElement>
  onClick: () => void
  active: boolean
  icon: ReactNode
}

export function T3ConversationMenu({ target, menuSide, onOpenChange, renderTrigger, newAction }: {
  /** Called when the menu opens; null disables it. */
  target: () => T3ConversationMenuTarget | null
  /** The action that opens a new conversation, whose key the "New
   *  conversation" tooltip shows. */
  newAction?: ActionId
  menuSide: 'up' | 'right'
  onOpenChange?: (open: boolean) => void
  /** Draws the toolbar button (client layout owns the toolbar chrome). */
  renderTrigger: (props: T3ConversationMenuTriggerProps) => ReactNode
}) {
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; bottom: number } | null>(null)
  const [current, setCurrent] = useState<T3ConversationMenuTarget | null>(null)
  const [search, setSearch] = useState('')
  const [threads, setThreads] = useState<T3Conversation[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const close = () => { setPosition(null); onOpenChange?.(false) }
  useDismissableLayer({ open: !!position, contentRef: content, triggerRefs: [trigger], onDismiss: close })

  useEffect(() => {
    if (!position || !current) return
    let cancelled = false
    setLoading(true); setError(''); setThreads([])
    void current.conversations.list().then((result) => {
      if (!cancelled) setThreads(result)
    }).catch((cause) => { if (!cancelled) setError(errorMessage(cause, 'Could not load conversations.')) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [position, current])

  const create = (thread?: T3Conversation) => {
    close()
    current?.open(thread)
  }
  const remove = async (thread: T3Conversation) => {
    if (!current) return
    setDeleting(thread.id)
    setError('')
    try {
      await current.conversations.remove(thread.id)
      setThreads((list) => list.filter((item) => item.id !== thread.id))
      setConfirmDelete(null)
    } catch (cause) { setError(errorMessage(cause, 'Could not delete conversation.')) }
    finally { setDeleting(null) }
  }
  const rename = async (thread: T3Conversation) => {
    if (!current || !title.trim() || saving) return
    setSaving(true); setError('')
    try {
      const nextTitle = title.trim()
      await current.conversations.rename(thread.id, nextTitle)
      setThreads((list) => list.map((item) => item.id === thread.id ? { ...item, title: nextTitle } : item))
      setRenaming(null)
    } catch (cause) { setError(errorMessage(cause, 'Could not rename conversation.')) }
    finally { setSaving(false) }
  }
  const toggle = () => {
    if (position) { close(); return }
    const rect = trigger.current?.getBoundingClientRect()
    const next = target()
    if (!rect || !next) return
    setCurrent(next)
    setSearch('')
    setConfirmDelete(null)
    setRenaming(null)
    setPosition({
      left: Math.max(8, Math.min(menuSide === 'right' ? rect.right + 8 : rect.left + rect.width / 2 - 110, window.innerWidth - 228)),
      bottom: Math.max(8, menuSide === 'right' ? window.innerHeight - rect.bottom : window.innerHeight - rect.top + 10),
    })
    onOpenChange?.(true)
  }
  const filtered = threads.filter((thread) => thread.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))

  return <>
    {renderTrigger({ ref: trigger, onClick: toggle, active: !!position, icon: <T3Logo size={18} /> })}
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
          {renaming === thread.id ? <form className="px-1.5 py-1" onSubmit={(event) => { event.preventDefault(); void rename(thread) }}>
            <input autoFocus aria-label="Conversation name" value={title} disabled={saving} onChange={(event) => setTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRenaming(null) } }} className="w-full rounded bg-surface-3 px-1 py-1 text-primary" />
            <div className="flex gap-3 py-1"><button disabled={saving || !title.trim()} className="inline-flex items-center gap-1 text-secondary disabled:opacity-50">{saving && <Spinner size={11} />}{saving ? 'Saving' : 'Save'}</button><button type="button" disabled={saving} onClick={() => setRenaming(null)} className="text-muted">Cancel</button></div>
          </form> : confirmDelete === thread.id ? <div className="px-1.5 py-1 text-[11px]">
            <p className="text-secondary">Delete “{thread.title}”?</p>
            <div className="flex gap-3 py-1"><button disabled={!!deleting} onClick={() => void remove(thread)} className="text-red-400 disabled:opacity-50">{deleting === thread.id ? <Spinner size={12} label="Deleting conversation" /> : 'Delete'}</button><button disabled={!!deleting} onClick={() => setConfirmDelete(null)} className="text-muted">Cancel</button></div>
          </div> : <div className="flex items-center">
            <button onClick={() => create(thread)} className="min-w-0 flex flex-1 items-center gap-2 h-[26px] px-1.5 text-[12px] text-secondary hover:text-primary transition-colors" title={thread.title}><T3Logo size={13} className="shrink-0 text-muted" /><span className="truncate">{thread.title}</span></button>
            <button aria-label={`Delete ${thread.title}`} disabled={!!deleting} onClick={() => setConfirmDelete(thread.id)} className="p-1.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-red-400"><Trash size={12} /></button>
            <button aria-label={`Rename ${thread.title}`} onClick={() => { setTitle(thread.title); setRenaming(thread.id) }} className="p-1.5 text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-primary"><PencilSimple size={12} /></button>
          </div>}
        </div>)}
      </div>
      <div className="my-1 h-px bg-surface-5 mx-2.5 shrink-0" />
      <Tooltip action={newAction} label="New conversation"><button onClick={() => create()} className="mx-1 w-[calc(100%-0.5rem)] flex shrink-0 items-center gap-2 h-[26px] px-1.5 rounded-lg text-[12px] text-secondary hover:text-primary hover:bg-surface-4 transition-colors"><Plus size={13} className="shrink-0" />New conversation</button></Tooltip>
    </div>, document.body)}
  </>
}
