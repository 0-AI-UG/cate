// The chat panel's conversation pill: switch the panel to another
// conversation of its checkout, start a new one, or rename the current one.

import { useState } from 'react'
import { MessageCircleMore as ChatsCircle } from 'lucide-react'
import { Modal, Spinner } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import type { T3Conversation } from '@services/t3/contract'
import type { T3ConversationSource } from '@services/t3/client'

export function T3ConversationPill({ title, threadId, conversations, onSelect }: {
  /** The panel's title. */
  title: string
  threadId: string | null
  /** The panel's checkout; null while unknown. */
  conversations: T3ConversationSource | null
  /** Shows `thread` in the panel; undefined starts a new conversation. */
  onSelect: (thread: T3Conversation | undefined) => void
}) {
  const [hovered, setHovered] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [renameTitle, setRenameTitle] = useState<string | null>(null)
  const label = loading ? 'Loading chats' : error || title || 'Select chat'

  const select = async () => {
    if (!conversations) return
    setLoading(true)
    setError('')
    try {
      const threads = await conversations.list()
      const choice = await clientUi().showContextMenu?.([
        { id: '__new', label: 'New conversation' },
        ...(threadId ? [{ id: '__rename', label: 'Rename conversation…' }] : []),
        { type: 'separator' },
        ...threads.map((thread) => ({ id: thread.id, label: thread.title + (thread.id === threadId ? '  ✓' : '') })),
      ])
      if (!choice || choice === threadId) return
      if (choice === '__rename') {
        setRenameTitle(threads.find((thread) => thread.id === threadId)?.title ?? title)
        return
      }
      const thread = threads.find((item) => item.id === choice)
      if (choice !== '__new' && !thread) return
      onSelect(thread)
    } catch (cause) {
      setError(errorMessage(cause, 'Could not load conversations.'))
    } finally {
      setLoading(false)
    }
  }

  return <><button
    type="button"
    aria-label="Select chat"
    title={error || `Chat: ${title || 'New conversation'}`}
    disabled={loading || !conversations}
    onClick={(event) => { event.stopPropagation(); void select() }}
    onMouseDown={(event) => event.stopPropagation()}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocus={() => setHovered(true)}
    onBlur={() => setHovered(false)}
    className="inline-flex h-[18px] max-w-[220px] cursor-pointer select-none items-center rounded-full border-0 bg-surface-2 text-secondary shadow-sm hover:text-primary disabled:opacity-60"
    style={{ gap: hovered ? 4 : 0, padding: hovered ? '0 9px 0 7px' : '0 4px', fontSize: 10, fontWeight: 600, lineHeight: 1, transition: 'gap 150ms ease, padding 150ms ease' }}
  >
    {loading ? <Spinner size={11} label="Loading conversations" /> : <ChatsCircle size={11} className="shrink-0" />}
    <span style={{ maxWidth: hovered ? 180 : 0, opacity: hovered ? 1 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'max-width 150ms ease, opacity 150ms ease' }}>{label}</span>
  </button>{renameTitle !== null && <Modal title="Rename conversation" width={360} dismissable={!loading} onClose={() => { if (!loading) setRenameTitle(null) }}>
    <form className="p-4" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault()
      if (!renameTitle.trim() || !threadId || !conversations || loading) return
      setLoading(true); setError('')
      try {
        await conversations.rename(threadId, renameTitle.trim())
        setRenameTitle(null)
      } catch (cause) { setError(errorMessage(cause, 'Could not rename conversation.')) }
      finally { setLoading(false) }
    }}>
      <label className="text-sm text-primary">Conversation name<input autoFocus value={renameTitle} disabled={loading} onChange={(event) => setRenameTitle(event.target.value)} className="mt-2 w-full rounded bg-surface-3 px-2 py-1 text-sm" /></label>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex justify-end gap-3 text-xs"><button type="button" disabled={loading} onClick={() => setRenameTitle(null)} className="text-muted">Cancel</button><button disabled={loading || !renameTitle.trim()} className="inline-flex items-center gap-1 text-primary disabled:opacity-50">{loading && <Spinner size={11} />}{loading ? 'Saving' : 'Save'}</button></div>
    </form>
  </Modal>}</>
}
