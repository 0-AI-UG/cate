import { useState } from 'react'
import { ChatsCircle } from '@phosphor-icons/react'
import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { Modal } from '../ui/Modal'

export function T3ConversationPill({ panel, workspaceId }: { panel: PanelState; workspaceId: string }) {
  const [hovered, setHovered] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [renameTitle, setRenameTitle] = useState<string | null>(null)
  const [renameCwd, setRenameCwd] = useState('')
  const label = loading ? 'Loading chats…' : error || panel.title || 'Select chat'

  const select = async () => {
    const workspace = useAppStore.getState().workspaces.find((item) => item.id === workspaceId)
    const cwd = panel.cwd ?? workspace?.worktrees?.find((item) => item.id === panel.worktreeId)?.path ?? workspace?.rootPath
    if (!cwd) return
    setLoading(true)
    setError('')
    try {
      const result = await window.electronAPI.agentHarnessListConversations({ workspaceId, cwd })
      if ('error' in result) { setError(result.error); return }
      const threads = result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const choice = await window.electronAPI.showContextMenu([
        { id: '__new', label: 'New conversation' },
        ...(panel.agentThreadId ? [{ id: '__rename', label: 'Rename conversation…' }] : []),
        { type: 'separator' },
        ...threads.map((thread) => ({ id: thread.id, label: thread.title + (thread.id === panel.agentThreadId ? '  ✓' : '') })),
      ])
      if (!choice || choice === panel.agentThreadId) return
      if (choice === '__rename') {
        setRenameCwd(cwd)
        setRenameTitle(threads.find((thread) => thread.id === panel.agentThreadId)?.title ?? panel.title)
        return
      }
      const thread = threads.find((item) => item.id === choice)
      if (choice !== '__new' && !thread) return
      const app = useAppStore.getState()
      const current = app.workspaces.find((item) => item.id === workspaceId)?.panels[panel.id]
      if (!current || current.cwd !== panel.cwd || current.worktreeId !== panel.worktreeId || current.agentThreadId !== panel.agentThreadId) return
      app.setPanelAgentThreadId(workspaceId, panel.id, thread?.id)
      app.updatePanelTitleFromAgent(workspaceId, panel.id, thread?.title ?? 'T3 Code')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load conversations.')
    } finally {
      setLoading(false)
    }
  }

  return <><button
    type="button"
    aria-label="Select chat"
    title={error || `Chat: ${panel.title || 'New conversation'}`}
    disabled={loading}
    onClick={(event) => { event.stopPropagation(); void select() }}
    onMouseDown={(event) => event.stopPropagation()}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocus={() => setHovered(true)}
    onBlur={() => setHovered(false)}
    className="inline-flex h-[18px] max-w-[220px] cursor-pointer select-none items-center rounded-full border-0 bg-surface-2 text-secondary shadow-sm hover:text-primary disabled:opacity-60"
    style={{ gap: hovered ? 4 : 0, padding: hovered ? '0 9px 0 7px' : '0 4px', fontSize: 10, fontWeight: 600, lineHeight: 1, transition: 'gap 150ms ease, padding 150ms ease' }}
  >
    <ChatsCircle size={11} className="shrink-0" />
    <span style={{ maxWidth: hovered ? 180 : 0, opacity: hovered ? 1 : 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'max-width 150ms ease, opacity 150ms ease' }}>{label}</span>
  </button>{renameTitle !== null && <Modal title="Rename conversation" width={360} dismissable={!loading} onClose={() => { if (!loading) setRenameTitle(null) }}>
    <form className="p-4" onMouseDown={(event) => event.stopPropagation()} onSubmit={async (event) => {
      event.preventDefault()
      if (!renameTitle.trim() || !panel.agentThreadId || loading) return
      setLoading(true); setError('')
      try {
        const title = renameTitle.trim()
        const result = await window.electronAPI.agentHarnessRenameConversation({ workspaceId, cwd: renameCwd, threadId: panel.agentThreadId, title })
        if ('error' in result) { setError(result.error); return }
        setRenameTitle(null)
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename conversation.') }
      finally { setLoading(false) }
    }}>
      <label className="text-sm text-primary">Conversation name<input autoFocus value={renameTitle} disabled={loading} onChange={(event) => setRenameTitle(event.target.value)} className="mt-2 w-full rounded bg-surface-3 px-2 py-1 text-sm" /></label>
      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-3 flex justify-end gap-3 text-xs"><button type="button" disabled={loading} onClick={() => setRenameTitle(null)} className="text-muted">Cancel</button><button disabled={loading || !renameTitle.trim()} className="text-primary disabled:opacity-50">{loading ? 'Saving…' : 'Save'}</button></div>
    </form>
  </Modal>}</>
}
