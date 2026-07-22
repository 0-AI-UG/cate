// =============================================================================
// CateAgentComposer — the sidebar's message composer, laid out like a stacked
// card: the main card holds the textarea with a control row beneath it (MODEL
// picker on the left; STOP while a run is active, and SEND, on the right — so the
// send button always sits at the bottom-right, never floating mid-height). A
// second card tucks under the main one and sticks out below: the WORKTREE
// selector. Both menus open UPWARD (the composer lives at the panel's bottom
// edge).
//
// Neither picker is hand-rolled: the model menu is the shared ModelPickerDropdown
// (same control as the agent panel header and Settings → Providers), and the
// worktree menu reads the shared useWorktrees join and creates through the shared
// CreateWorktreeForm + useWorktreeActions, exactly like the canvas drop-up.
//
// The model pref is real (feeds cateAgentModel()); Stop routes to
// cateAgentController.stop. The draft is shared with the toolbar card via the same
// per-workspace key, so an unsent message follows you.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, Stop, Check, ArrowUp, Plus } from '@phosphor-icons/react'
import { useAutoGrowingTextarea } from '../lib/hooks/useAutoGrowingTextarea'
import { sendCateAgentMessage } from './cateAgentSend'
import { cateAgentController } from './cateAgentController'
import { useCateAgentWs } from './cateAgentStore'
import { useChatsStore } from '../stores/chatsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorktrees, type JoinedWorktree } from '../stores/useWorktrees'
import { useWorktreeActions } from '../stores/useWorktreeActions'
import { CreateWorktreeForm } from '../sidebar/CreateWorktreeForm'
import { ModelPickerDropdown } from '../../agent/renderer/ModelPicker'
import { getTargetWorktree, setTargetWorktree } from './cateAgentWorktreeTarget'
import { loadCateAgentModel, saveCateAgentModel, loadDefaultModel } from '../../agent/renderer/agentModelPrefs'
import type { AgentModelRef } from '../../shared/types'

const MAX_HEIGHT = 160
type ModelOption = { provider: string; model: string; label?: string }

const worktreeLabel = (wt: JoinedWorktree | undefined): string =>
  wt?.label || wt?.branch || (wt?.isPrimary ? 'main' : 'worktree')

// --- shared draft (same key the toolbar bar uses, so a draft follows you) -----
const draftKey = (wsId: string): string => `cate.agentDraft.${wsId}`
const loadDraft = (wsId: string): string => {
  try {
    return wsId ? localStorage.getItem(draftKey(wsId)) ?? '' : ''
  } catch {
    return ''
  }
}
const saveDraft = (wsId: string, value: string): void => {
  try {
    if (!wsId) return
    if (value) localStorage.setItem(draftKey(wsId), value)
    else localStorage.removeItem(draftKey(wsId))
  } catch {
    /* best-effort */
  }
}

// --- an upward-opening portal menu anchored above a trigger --------------------
const UpwardMenu: React.FC<{ anchor: DOMRect; width: number; onClose: () => void; children: React.ReactNode }> = ({
  anchor,
  width,
  onClose,
  children,
}) => {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={ref}
      role="listbox"
      className="fixed z-[60] max-h-[340px] overflow-y-auto no-scrollbar p-1.5 rounded-xl border border-strong bg-surface-4 shadow-[0_12px_32px_var(--shadow-node)]"
      style={{ left: anchor.left, bottom: window.innerHeight - anchor.top + 6, width }}
    >
      {children}
    </div>,
    document.body,
  )
}

const MenuRow: React.FC<{ selected: boolean; onClick: () => void; children: React.ReactNode }> = ({ selected, onClick, children }) => (
  <button
    type="button"
    role="option"
    aria-selected={selected}
    onClick={onClick}
    className={`flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-left text-[12px] transition-colors ${
      selected ? 'text-primary bg-hover' : 'text-secondary hover:text-primary hover:bg-hover'
    }`}
  >
    {children}
    {selected && <Check size={12} className="flex-shrink-0 text-secondary" />}
  </button>
)

// A small pill trigger for the control row / worktree bar.
const PillButton = React.forwardRef<HTMLButtonElement, { onClick: () => void; open: boolean; title: string; children: React.ReactNode; className?: string }>(
  ({ onClick, open, title, children, className = '' }, ref) => (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 h-6 max-w-[180px] px-2 rounded-md text-[11px] text-secondary hover:text-primary hover:bg-hover transition-colors ${className}`}
    >
      {children}
      <CaretDown size={10} className={`flex-shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  ),
)
PillButton.displayName = 'PillButton'

export const CateAgentComposer: React.FC<{ wsId: string; rootPath: string }> = ({ wsId, rootPath }) => {
  const cateAgent = useCateAgentWs(wsId)
  const chats = useChatsStore((s) => s.chatsByRoot[rootPath]) ?? []
  const activeChat = cateAgent.activeChatId ? chats.find((c) => c.id === cateAgent.activeChatId) : undefined
  const running = activeChat?.run?.status === 'running'

  const [text, setText] = React.useState(() => loadDraft(wsId))
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const resize = useAutoGrowingTextarea(taRef, text, { maxHeight: MAX_HEIGHT, observeWidth: true })

  const [models, setModels] = React.useState<ModelOption[]>([])
  const [model, setModel] = React.useState<AgentModelRef | null>(() => loadCateAgentModel())
  const [modelOpen, setModelOpen] = React.useState(false)
  // The worktree the active chat works against (null = whatever is checked out).
  // Re-read whenever the chat changes — each chat remembers its own.
  const [targetId, setTargetId] = React.useState<string | null>(() => getTargetWorktree(cateAgent.activeChatId ?? ''))
  const [wtAnchor, setWtAnchor] = React.useState<DOMRect | null>(null)
  const [creating, setCreating] = React.useState(false)
  const wtBtn = React.useRef<HTMLButtonElement>(null)

  // The workspace's worktrees, from the same read-time join every other worktree
  // surface uses. Orphans (metadata whose checkout is gone) are not pickable.
  const joined = useWorktrees(rootPath, wsId)
  const worktrees = React.useMemo(() => joined.filter((w) => !w.isOrphan), [joined])
  const { createWorktree, checkoutPr } = useWorktreeActions(rootPath, wsId)

  // Fetch the provider-grouped model list once (same source as the agent panel).
  React.useEffect(() => {
    let alive = true
    window.electronAPI
      .agentListModels()
      .then((list) => {
        if (alive) setModels(list.map((m) => ({ provider: m.provider, model: m.id, label: m.label })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Follow the active chat: each chat remembers its own worktree.
  React.useEffect(() => {
    setTargetId(getTargetWorktree(cateAgent.activeChatId ?? ''))
  }, [cateAgent.activeChatId])

  React.useEffect(() => {
    resize()
  }, [resize])

  const update = (value: string): void => {
    const normalized = value.replace(/\r\n?/g, '\n').replace(/^\n+/, '')
    setText(normalized)
    saveDraft(wsId, normalized)
  }
  const send = (): void => {
    const t = text.trim()
    if (!t) return
    sendCateAgentMessage(wsId, rootPath, t, targetId ?? undefined)
    update('')
  }

  // Pick the worktree for the active chat. Carried to a new chat on send() when
  // none is active yet (so a pick made before the first message still counts).
  const pickWorktree = (id: string): void => {
    setTargetId(id)
    if (cateAgent.activeChatId) setTargetWorktree(cateAgent.activeChatId, id)
    setWtAnchor(null)
  }

  const closeWorktreeMenu = (): void => {
    setWtAnchor(null)
    setCreating(false)
  }

  // With no Cate Agent pref the session falls back to the global default model, so
  // show THAT rather than a "Default model" row — the fallback stays implicit, the
  // pill and the checkmark always name a real model (same as the agent panel).
  const effectiveModel = model ?? loadDefaultModel()
  const modelLabel = effectiveModel
    ? models.find((m) => m.provider === effectiveModel.provider && m.model === effectiveModel.model)?.label ??
      effectiveModel.model
    : 'Pick a model'
  // Unpicked falls back to the checked-out worktree — the same default the land
  // step uses — so the pill always shows where the work will actually go.
  const current = worktrees.find((w) => w.isCurrent) ?? worktrees.find((w) => w.isPrimary)
  const target = worktrees.find((w) => w.id === targetId) ?? current

  return (
    <div className="flex flex-col">
      {/* Main composer card */}
      <div className="relative z-10 rounded-2xl border border-subtle bg-surface-2 shadow-[0_6px_20px_-8px_var(--shadow-node)]">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            } else if (e.key === 'Escape') {
              taRef.current?.blur()
            }
          }}
          placeholder="Message Cate…"
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-snug text-primary outline-none placeholder:text-muted no-scrollbar"
          style={{ maxHeight: MAX_HEIGHT }}
        />
        <div className="relative flex items-center gap-1 px-1.5 pb-1.5">
          <PillButton open={modelOpen} title="Model for the Cate Agent" onClick={() => setModelOpen((v) => !v)}>
            <span className="truncate">{modelLabel}</span>
          </PillButton>
          {modelOpen && (
            <ModelPickerDropdown
              models={models}
              selected={effectiveModel}
              className="bottom-full mb-2 left-0 right-0 max-h-[320px]"
              onPick={(m) => {
                const next = { provider: m.provider, model: m.model }
                setModel(next)
                saveCateAgentModel(next)
                setModelOpen(false)
              }}
              onClose={() => setModelOpen(false)}
              onManage={() => {
                setModelOpen(false)
                useUIStore.getState().openSettings('providers')
              }}
            />
          )}
          <div className="flex-1" />
          {running && (
            <button
              type="button"
              onClick={() => activeChat && cateAgentController.stop(wsId, activeChat.id)}
              title="Stop the run"
              className="flex items-center gap-1 h-7 px-2 rounded-md text-[11px] text-secondary hover:text-red-400 hover:bg-hover transition-colors"
            >
              <Stop size={11} weight="fill" /> Stop
            </button>
          )}
          <button
            type="button"
            onClick={send}
            disabled={!text.trim()}
            aria-label="Send"
            title="Send"
            className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full border border-strong bg-transparent text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>

      {/* Worktree selector: a lower card tucked under the composer, sticking out
          below. The run branches off this worktree and lands back into it. */}
      <div className="relative z-0 mx-2 -mt-3 rounded-b-xl border border-t-0 border-subtle bg-surface-1 px-2 pt-5 pb-1.5">
        <PillButton
          ref={wtBtn}
          open={!!wtAnchor}
          title="Worktree this task branches off and lands back into"
          onClick={() => (wtAnchor ? closeWorktreeMenu() : setWtAnchor(wtBtn.current?.getBoundingClientRect() ?? null))}
        >
          <span
            className="w-2 h-2 flex-shrink-0 rounded-full"
            style={{ backgroundColor: target?.color || 'var(--text-muted)' }}
          />
          <span className="truncate">{worktreeLabel(target)}</span>
        </PillButton>
      </div>

      {wtAnchor && (
        <UpwardMenu anchor={wtAnchor} width={260} onClose={closeWorktreeMenu}>
          {creating ? (
            <CreateWorktreeForm
              defaultBaseBranch={current?.branch ?? ''}
              rootPath={rootPath}
              inlinePicker
              flat
              onSubmit={async (name, baseRef) => {
                const meta = await createWorktree(name, baseRef)
                if (meta) pickWorktree(meta.id)
                closeWorktreeMenu()
              }}
              onCheckoutPr={async (pr) => {
                const meta = await checkoutPr(pr)
                if (meta) pickWorktree(meta.id)
                closeWorktreeMenu()
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <>
              <div className="px-2 pt-1 pb-1.5 text-[10px] leading-tight text-muted">Work in…</div>
              {worktrees.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted">No worktrees</div>}
              {worktrees.map((w) => (
                <MenuRow key={w.id} selected={w.id === target?.id} onClick={() => pickWorktree(w.id)}>
                  <span
                    className="w-2 h-2 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: w.color || 'var(--text-muted)' }}
                  />
                  <span className="flex-1 truncate">{worktreeLabel(w)}</span>
                  {w.isPrimary && <span className="text-[10px] text-muted">base</span>}
                </MenuRow>
              ))}
              <div className="my-1 h-px bg-surface-5 mx-1" />
              <MenuRow selected={false} onClick={() => setCreating(true)}>
                <Plus size={12} className="flex-shrink-0 text-muted" />
                <span className="flex-1 truncate">Create new worktree…</span>
              </MenuRow>
            </>
          )}
        </UpwardMenu>
      )}
    </div>
  )
}
