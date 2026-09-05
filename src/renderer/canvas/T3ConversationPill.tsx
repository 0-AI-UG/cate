import { useState } from 'react'
import { ChatsCircle } from '@phosphor-icons/react'
import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'

export function T3ConversationPill({ panel, workspaceId }: { panel: PanelState; workspaceId: string }) {
  const [hovered, setHovered] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
        { type: 'separator' },
        ...threads.map((thread) => ({ id: thread.id, label: thread.title + (thread.id === panel.agentThreadId ? '  ✓' : '') })),
      ])
      if (!choice || choice === panel.agentThreadId) return
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

  return <button
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
  </button>
}
