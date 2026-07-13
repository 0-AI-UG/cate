// =============================================================================
// CateAgentComposer — the sidebar's message composer, laid out like a stacked
// card: the main card holds the textarea with a control row beneath it (MODEL
// picker on the left; STOP while a run is active, and SEND, on the right — so the
// send button always sits at the bottom-right, never floating mid-height). A
// second card tucks under the main one and sticks out below: the BRANCH selector,
// listing the workspace's worktrees. Both menus open UPWARD (the composer lives
// at the panel's bottom edge). The model pref is real (feeds cateAgentModel());
// Stop routes to cateAgentController.stop. The draft is shared with the toolbar
// card via the same per-workspace key, so an unsent message follows you.
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import { CaretDown, Stop, Check, ArrowUp, GitBranch } from '@phosphor-icons/react'
import { useAutoGrowingTextarea } from '../lib/hooks/useAutoGrowingTextarea'
import { sendCateAgentMessage } from './cateAgentSend'
import { cateAgentController } from './cateAgentController'
import { useCateAgentWs } from './cateAgentStore'
import { useChatsStore } from '../stores/chatsStore'
import { getLandTarget, setLandTarget } from './cateAgentLandTarget'
import { loadCateAgentModel, saveCateAgentModel } from '../../agent/renderer/agentModelPrefs'
import type { AgentModelRef } from '../../shared/types'

const MAX_HEIGHT = 160
type ModelOption = { provider: string; model: string; label?: string }
type BranchOption = { name: string; current: boolean; label: string }

const sameModel = (a: AgentModelRef | null, m: ModelOption): boolean =>
  !!a && a.provider === m.provider && a.model === m.model

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
    {selected && <Check size={12} weight="bold" className="flex-shrink-0 text-secondary" />}
  </button>
)

// A small pill trigger for the control row / branch bar.
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
      <CaretDown size={10} weight="bold" className={`flex-shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
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
  const [branches, setBranches] = React.useState<BranchOption[]>([])
  // The chosen merge target for the active chat (null = default: land into the
  // branch that is checked out at land time). Re-read whenever the chat changes.
  const [landBranch, setLandBranch] = React.useState<string | null>(() => getLandTarget(cateAgent.activeChatId ?? ''))
  const [modelAnchor, setModelAnchor] = React.useState<DOMRect | null>(null)
  const [branchAnchor, setBranchAnchor] = React.useState<DOMRect | null>(null)
  const modelBtn = React.useRef<HTMLButtonElement>(null)
  const branchBtn = React.useRef<HTMLButtonElement>(null)

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

  // Local branches of this repo — the candidate merge targets for the land step.
  React.useEffect(() => {
    if (!rootPath) return
    let alive = true
    window.electronAPI
      .gitBranchList(rootPath, wsId)
      .then((res) => {
        if (alive) setBranches(res.branches.filter((b) => !b.isRemote).map((b) => ({ name: b.name, current: b.current, label: b.label })))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [rootPath, wsId])

  // Follow the active chat: each chat remembers its own merge target.
  React.useEffect(() => {
    setLandBranch(getLandTarget(cateAgent.activeChatId ?? ''))
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
    sendCateAgentMessage(wsId, rootPath, t, landBranch ?? undefined)
    update('')
  }

  // Pick a merge target for the active chat. Carried to a new chat on send() when
  // none is active yet (so a pick made before the first message still lands).
  const pickBranch = (name: string): void => {
    setLandBranch(name)
    if (cateAgent.activeChatId) setLandTarget(cateAgent.activeChatId, name)
    setBranchAnchor(null)
  }

  const modelLabel = model ? models.find((m) => sameModel(model, m))?.label ?? model.model : 'Auto'
  const currentBranchName = branches.find((b) => b.current)?.name
  const targetBranch = landBranch ?? currentBranchName ?? 'main'

  const groups = React.useMemo(() => {
    const out = new Map<string, ModelOption[]>()
    for (const m of models) {
      const arr = out.get(m.provider) ?? []
      arr.push(m)
      out.set(m.provider, arr)
    }
    return Array.from(out.entries())
  }, [models])

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
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          <PillButton
            ref={modelBtn}
            open={!!modelAnchor}
            title="Model for the Cate Agent"
            onClick={() => setModelAnchor(modelAnchor ? null : modelBtn.current?.getBoundingClientRect() ?? null)}
          >
            <span className="truncate">{modelLabel}</span>
          </PillButton>
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
            <ArrowUp size={15} weight="bold" />
          </button>
        </div>
      </div>

      {/* Merge-target selector: a lower card tucked under the composer, sticking out
          below. The winning run lands INTO this branch. */}
      <div className="relative z-0 mx-2 -mt-3 rounded-b-xl border border-t-0 border-subtle bg-surface-1 px-2 pt-5 pb-1.5">
        <PillButton
          ref={branchBtn}
          open={!!branchAnchor}
          title="Branch the result merges into"
          onClick={() => setBranchAnchor(branchAnchor ? null : branchBtn.current?.getBoundingClientRect() ?? null)}
        >
          <GitBranch size={11} className="flex-shrink-0 text-muted" />
          <span className="truncate">{targetBranch}</span>
        </PillButton>
      </div>

      {modelAnchor && (
        <UpwardMenu anchor={modelAnchor} width={248} onClose={() => setModelAnchor(null)}>
          <MenuRow selected={!model} onClick={() => { setModel(null); saveCateAgentModel(null); setModelAnchor(null) }}>
            <span className="flex-1 truncate">Auto</span>
            <span className="text-[10px] text-muted">first available</span>
          </MenuRow>
          {groups.map(([provider, opts]) => (
            <React.Fragment key={provider}>
              <div className="px-2 pt-2 pb-1 font-mono text-[9.5px] tracking-[0.1em] uppercase text-muted">{provider}</div>
              {opts.map((m) => (
                <MenuRow
                  key={`${m.provider}/${m.model}`}
                  selected={sameModel(model, m)}
                  onClick={() => { const ref = { provider: m.provider, model: m.model }; setModel(ref); saveCateAgentModel(ref); setModelAnchor(null) }}
                >
                  <span className="flex-1 truncate">{m.label ?? m.model}</span>
                </MenuRow>
              ))}
            </React.Fragment>
          ))}
          {models.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted">No models available</div>}
        </UpwardMenu>
      )}

      {branchAnchor && (
        <UpwardMenu anchor={branchAnchor} width={220} onClose={() => setBranchAnchor(null)}>
          <div className="px-2 pt-1 pb-1.5 text-[10px] leading-tight text-muted">Merge the result into…</div>
          {branches.length === 0 && <div className="px-2 py-3 text-center text-[11px] text-muted">No branches</div>}
          {branches.map((b) => (
            <MenuRow key={b.name} selected={b.name === targetBranch} onClick={() => pickBranch(b.name)}>
              <GitBranch size={12} className="flex-shrink-0 text-muted" />
              <span className="flex-1 truncate">{b.label || b.name}</span>
              {b.current && <span className="text-[10px] text-muted">current</span>}
            </MenuRow>
          ))}
        </UpwardMenu>
      )}
    </div>
  )
}
