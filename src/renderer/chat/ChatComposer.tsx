// =============================================================================
// ChatComposer — the one composer both chat surfaces render: the Cate Agent
// sidebar and the agent panel's bottom-of-thread input.
//
// Shape (from the Cate Agent sidebar): a stacked card. The main card holds the
// textarea with a control row beneath it — model picker on the left, the run
// controls on the right, so the send button always sits at the bottom-right,
// never floating mid-height. A second card tucks under the main one and sticks
// out below: the worktree selector. Both menus open UPWARD (the composer lives
// at its panel's bottom edge).
//
// Capabilities (from the agent panel composer): image attachments, thinking
// level, plan mode, context compaction, the stats chip, the slash-command
// popup and file drag-and-drop.
//
// PRESENTATIONAL ONLY — no stores, no IPC, no persistence. Every value and
// every action comes in through props; the two call sites own their data. The
// only local state is transient UI (menu open, drag-over, slash index).
// =============================================================================

import React from 'react'
import { createPortal } from 'react-dom'
import {
  CaretDown,
  Stop,
  Check,
  ArrowUp,
  Plus,
  ClipboardText,
  Spinner,
  ArrowsClockwise,
} from '@phosphor-icons/react'
import { useAutoGrowingTextarea } from '../lib/hooks/useAutoGrowingTextarea'
import { Tooltip } from '../ui/Tooltip'
import { CreateWorktreeForm, type PrListItem } from '../sidebar/CreateWorktreeForm'
import { ModelPickerDropdown } from '../../agent/renderer/ModelPicker'
import {
  ImageAttachButton,
  ImageChips,
  ThinkingLevelPicker,
  NodePopover,
  useNodePopover,
} from '../../agent/renderer/AgentPanelChrome'
import type { JoinedWorktree } from '../stores/useWorktrees'
import type {
  AgentImageAttachment,
  AgentModelRef,
  AgentSessionStats,
  AgentSlashCommand,
  AgentThinkingLevel,
} from '../../shared/types'

const MAX_HEIGHT = 160

export type ModelOption = { provider: string; model: string; label?: string }

const worktreeLabel = (wt: JoinedWorktree | undefined): string =>
  wt?.label || wt?.branch || (wt?.isPrimary ? 'main' : 'worktree')

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

export interface ChatComposerProps {
  // core — always rendered
  draft: string
  onChange: (s: string) => void
  onSubmit: () => void
  onStop: () => void
  disabled: boolean
  running: boolean
  placeholder?: string
  /** Falls back to an internal ref when the parent doesn't need one. */
  textareaRef?: React.RefObject<HTMLTextAreaElement>

  // model pill — rendered iff onPickModel is supplied
  models?: ModelOption[]
  selectedModel?: AgentModelRef | null
  onPickModel?: (m: ModelOption) => void
  onManageModels?: () => void
  /** Fired when the model menu opens, so the call site can refresh the list. */
  onModelMenuOpen?: () => void

  // worktree card — rendered iff onPickWorktree is supplied
  worktrees?: JoinedWorktree[]
  selectedWorktreeId?: string | null
  onPickWorktree?: (id: string) => void
  worktreeMenuHeading?: string
  worktreeTitle?: string
  /** Repo root, for the create-worktree form. Falls back to the primary worktree. */
  rootPath?: string
  /** Returns the new worktree's id, which becomes the selection. */
  onCreateWorktree?: (name: string, baseRef: string) => Promise<string | null>
  onCheckoutPr?: (pr: unknown) => Promise<string | null>

  // optional capabilities — each rendered iff its handler is supplied
  images?: AgentImageAttachment[]
  onAddImage?: (img: AgentImageAttachment) => void
  onRemoveImage?: (idx: number) => void
  onPaste?: (e: React.ClipboardEvent) => void
  onDrop?: (e: React.DragEvent) => void
  commands?: AgentSlashCommand[]
  /** Fired when the slash-command popup opens (draft starts a `/command`), so the
   *  parent can refresh the command list — picks up newly-installed skills
   *  without reopening the panel. */
  onSlashOpen?: () => void
  thinkingLevel?: AgentThinkingLevel | null
  onPickThinkingLevel?: (level: AgentThinkingLevel) => void
  planModeActive?: boolean
  onTogglePlanMode?: () => void
  autoCompactionEnabled?: boolean
  onManualCompact?: () => void
  onToggleAutoCompaction?: () => void
  compactionActive?: boolean
  stats?: AgentSessionStats | null
}

export const ChatComposer: React.FC<ChatComposerProps> = ({
  draft,
  onChange,
  onSubmit,
  onStop,
  disabled,
  running,
  placeholder: placeholderOverride,
  textareaRef,
  models = [],
  selectedModel = null,
  onPickModel,
  onManageModels,
  onModelMenuOpen,
  worktrees = [],
  selectedWorktreeId = null,
  onPickWorktree,
  worktreeMenuHeading = 'Work in…',
  worktreeTitle,
  rootPath: rootPathProp,
  onCreateWorktree,
  onCheckoutPr,
  images = [],
  onAddImage,
  onRemoveImage,
  onPaste,
  onDrop,
  commands = [],
  onSlashOpen,
  thinkingLevel = null,
  onPickThinkingLevel,
  planModeActive = false,
  onTogglePlanMode,
  autoCompactionEnabled = false,
  onManualCompact,
  onToggleAutoCompaction,
  compactionActive = false,
  stats = null,
}) => {
  const innerRef = React.useRef<HTMLTextAreaElement>(null)
  const taRef = textareaRef ?? innerRef
  const resize = useAutoGrowingTextarea(taRef, draft, { maxHeight: MAX_HEIGHT, observeWidth: true })
  React.useEffect(() => {
    resize()
  }, [resize])

  const [modelOpen, setModelOpen] = React.useState(false)
  const [wtAnchor, setWtAnchor] = React.useState<DOMRect | null>(null)
  const [creating, setCreating] = React.useState(false)
  const wtBtn = React.useRef<HTMLButtonElement>(null)
  const [dragOver, setDragOver] = React.useState(false)

  // Slash popup is active when the draft starts with "/" and has no spaces
  // before the cursor — i.e. the user is still picking a command name.
  const slashMatch = React.useMemo(() => {
    if (!draft.startsWith('/')) return null
    if (draft.includes(' ') || draft.includes('\n')) return null
    return draft.slice(1).toLowerCase()
  }, [draft])

  // On the leading edge of a slash command (the user just typed "/"), ask the
  // parent to refresh the command list so freshly-installed skills/prompts show
  // up without reopening the panel. Fires once per open, not per keystroke.
  const slashWasOpen = React.useRef(false)
  React.useEffect(() => {
    const open = slashMatch != null
    if (open && !slashWasOpen.current) onSlashOpen?.()
    slashWasOpen.current = open
  }, [slashMatch, onSlashOpen])

  const filteredCommands = React.useMemo(() => {
    if (slashMatch == null) return []
    return commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch))
  }, [slashMatch, commands])

  const popupOpen = slashMatch != null && filteredCommands.length > 0
  const [selectedIdx, setSelectedIdx] = React.useState(0)
  React.useEffect(() => { setSelectedIdx(0) }, [slashMatch])

  const acceptCommand = (cmd: AgentSlashCommand): void => {
    // Insert "/<name> " so the user can immediately type the argument.
    onChange(`/${cmd.name} `)
    // Refocus textarea so they can keep typing.
    queueMicrotask(() => taRef.current?.focus())
  }

  const canSend = !disabled && (draft.trim().length > 0 || images.length > 0)

  // Accept either an internal file drag (cate-files / cate-file) or external
  // image files. Returning true tells the dragover handler to claim the event
  // so that ancestor drop zones (e.g. the canvas) don't also process it.
  const acceptsDrag = (e: React.DragEvent): boolean => {
    const types = e.dataTransfer?.types
    if (!types) return false
    return (
      types.includes('application/cate-files') ||
      types.includes('application/cate-file') ||
      types.includes('Files')
    )
  }

  const modelLabel = selectedModel
    ? models.find((m) => m.provider === selectedModel.provider && m.model === selectedModel.model)?.label ??
      selectedModel.model
    : 'Pick a model'

  // Unpicked falls back to the checked-out worktree — the same default the land
  // step uses — so the pill always shows where the work will actually go.
  const current = worktrees.find((w) => w.isCurrent) ?? worktrees.find((w) => w.isPrimary)
  const target = worktrees.find((w) => w.id === selectedWorktreeId) ?? current
  // The create form needs the repo root. Both call sites already have it, so it
  // comes in as a prop; the primary worktree's path is the same thing and only
  // serves as a fallback.
  const rootPath = rootPathProp ?? worktrees.find((w) => w.isPrimary)?.path ?? ''

  const pickWorktree = (id: string): void => {
    onPickWorktree?.(id)
    setWtAnchor(null)
  }

  const closeWorktreeMenu = (): void => {
    setWtAnchor(null)
    setCreating(false)
  }

  return (
    <div className="flex flex-col">
      {/* Main composer card */}
      <div
        onDragEnter={
          onDrop
            ? (e) => {
                if (!acceptsDrag(e)) return
                e.preventDefault()
                e.stopPropagation()
                setDragOver(true)
              }
            : undefined
        }
        onDragOver={
          onDrop
            ? (e) => {
                if (!acceptsDrag(e)) return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'copy'
              }
            : undefined
        }
        onDragLeave={
          onDrop
            ? (e) => {
                // Only clear when leaving the wrapper itself, not when moving between
                // children (relatedTarget would still be inside).
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                setDragOver(false)
              }
            : undefined
        }
        onDrop={
          onDrop
            ? (e) => {
                if (!acceptsDrag(e)) return
                e.stopPropagation()
                setDragOver(false)
                onDrop(e)
              }
            : undefined
        }
        className={`relative z-10 rounded-2xl border bg-surface-2 shadow-[0_6px_20px_-8px_var(--shadow-node)] transition-colors ${
          dragOver ? 'border-agent-light ring-2 ring-agent-light/40' : 'border-subtle'
        }`}
      >
        {popupOpen && (
          <SlashPopup
            commands={filteredCommands}
            selectedIdx={selectedIdx}
            onPick={acceptCommand}
            onHover={setSelectedIdx}
          />
        )}
        {onRemoveImage && <ImageChips images={images} onRemove={onRemoveImage} />}
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (popupOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIdx((i) => Math.min(i + 1, filteredCommands.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIdx((i) => Math.max(i - 1, 0))
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                acceptCommand(filteredCommands[selectedIdx])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                onChange('')
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (canSend) onSubmit()
            } else if (e.key === 'Escape') {
              // With no slash popup open, Escape releases focus — the sidebar
              // composer holds focus across the whole view, so there has to be a
              // way out that isn't a mouse click.
              taRef.current?.blur()
            }
          }}
          disabled={disabled || compactionActive}
          placeholder={
            compactionActive
              ? 'Compacting context…'
              : placeholderOverride ?? (running ? 'Steer the agent…' : 'Message the agent…')
          }
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm leading-snug text-primary outline-none placeholder:text-muted disabled:opacity-50 no-scrollbar"
          style={{ maxHeight: MAX_HEIGHT }}
        />
        <div className="relative flex items-center gap-1 px-1.5 pb-1.5">
          {onPickModel && (
            <>
              <PillButton
                open={modelOpen}
                title="Model for this chat"
                onClick={() => {
                  // Refresh on open, not on mount: a provider signed in since the
                  // composer mounted should show up without reopening the panel.
                  if (!modelOpen) onModelMenuOpen?.()
                  setModelOpen((v) => !v)
                }}
              >
                <span className="truncate">{modelLabel}</span>
              </PillButton>
              {modelOpen && (
                <ModelPickerDropdown
                  models={models}
                  selected={selectedModel}
                  className="bottom-full mb-2 left-0 right-0 max-h-[320px]"
                  onPick={(m) => {
                    onPickModel(m)
                    setModelOpen(false)
                  }}
                  onClose={() => setModelOpen(false)}
                  onManage={
                    onManageModels
                      ? () => {
                          setModelOpen(false)
                          onManageModels()
                        }
                      : undefined
                  }
                />
              )}
            </>
          )}
          {onAddImage && <ImageAttachButton onPick={onAddImage} />}
          {onPickThinkingLevel && <ThinkingLevelPicker level={thinkingLevel} onChange={onPickThinkingLevel} />}
          {onTogglePlanMode && (
            <Tooltip label="Plan mode: agent investigates with parallel scouts, proposes a plan, then waits for your approval." placement="top">
              <button
                onClick={onTogglePlanMode}
                className={`p-1.5 rounded-md ${
                  planModeActive
                    ? 'bg-agent/25 text-primary'
                    : 'text-primary/80 hover:bg-hover'
                }`}
                aria-label="Toggle plan mode"
              >
                <ClipboardText size={12} weight={planModeActive ? 'fill' : 'regular'} />
              </button>
            </Tooltip>
          )}
          {onManualCompact && onToggleAutoCompaction && (
            <CompactButton
              onManualCompact={onManualCompact}
              onToggleAutoCompaction={onToggleAutoCompaction}
              autoCompactionEnabled={autoCompactionEnabled}
              compactionActive={compactionActive}
            />
          )}
          <StatsChip stats={stats} />
          <div className="flex-1" />
          {compactionActive ? (
            <div
              title="Compacting context…"
              className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full border border-strong text-secondary opacity-60"
            >
              <Spinner size={15} weight="bold" className="animate-spin" />
            </div>
          ) : running && !canSend ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              title="Stop the run"
              className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full border border-strong bg-transparent text-secondary hover:text-red-400 hover:bg-hover-strong active:scale-[0.92] transition-all duration-100"
            >
              <Stop size={13} weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label={running ? 'Steer' : 'Send'}
              title={running ? 'Steer' : 'Send'}
              className="w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full border border-strong bg-transparent text-secondary hover:text-primary hover:bg-hover-strong active:scale-[0.92] transition-all duration-100 disabled:opacity-30"
            >
              <ArrowUp size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Worktree selector: a lower card tucked under the composer, sticking out
          below. The run branches off this worktree and lands back into it. */}
      {onPickWorktree && (
        <div className="relative z-0 mx-2 -mt-3 rounded-b-xl border border-t-0 border-subtle bg-surface-1 px-2 pt-5 pb-1.5">
          <PillButton
            ref={wtBtn}
            open={!!wtAnchor}
            title={worktreeTitle ?? 'Worktree this task branches off and lands back into'}
            onClick={() => (wtAnchor ? closeWorktreeMenu() : setWtAnchor(wtBtn.current?.getBoundingClientRect() ?? null))}
          >
            <span
              className="w-2 h-2 flex-shrink-0 rounded-full"
              style={{ backgroundColor: target?.color || 'var(--text-muted)' }}
            />
            <span className="truncate">{worktreeLabel(target)}</span>
          </PillButton>
        </div>
      )}

      {onPickWorktree && wtAnchor && (
        <UpwardMenu anchor={wtAnchor} width={260} onClose={closeWorktreeMenu}>
          {creating && onCreateWorktree ? (
            <CreateWorktreeForm
              defaultBaseBranch={current?.branch ?? ''}
              rootPath={rootPath}
              inlinePicker
              flat
              onSubmit={async (name, baseRef) => {
                const id = await onCreateWorktree(name, baseRef ?? '')
                if (id) pickWorktree(id)
                closeWorktreeMenu()
              }}
              onCheckoutPr={async (pr: PrListItem) => {
                const id = await onCheckoutPr?.(pr)
                if (id) pickWorktree(id)
                closeWorktreeMenu()
              }}
              onCancel={() => setCreating(false)}
            />
          ) : (
            <>
              <div className="px-2 pt-1 pb-1.5 text-[10px] leading-tight text-muted">{worktreeMenuHeading}</div>
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
              {onCreateWorktree && (
                <>
                  <div className="my-1 h-px bg-surface-5 mx-1" />
                  <MenuRow selected={false} onClick={() => setCreating(true)}>
                    <Plus size={12} className="flex-shrink-0 text-muted" />
                    <span className="flex-1 truncate">Create new worktree…</span>
                  </MenuRow>
                </>
              )}
            </>
          )}
        </UpwardMenu>
      )}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compact button — popover with confirm + auto-compact toggle.
// -----------------------------------------------------------------------------

function CompactButton({
  onManualCompact,
  onToggleAutoCompaction,
  autoCompactionEnabled,
  compactionActive,
}: {
  onManualCompact: () => void
  onToggleAutoCompaction: () => void
  autoCompactionEnabled: boolean
  compactionActive: boolean
}) {
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const { open, setOpen, popoverRef, pos, portalTarget } = useNodePopover(
    btnRef,
    (r) => {
      const popW = 200
      let left = r.left
      if (left + popW > window.innerWidth - 8) left = window.innerWidth - popW - 8
      return { top: r.top - 6, left }
    },
  )
  return (
    <>
      <Tooltip label="Compact context" placement="top">
        <button
          ref={btnRef}
          onClick={() => setOpen((v) => !v)}
          disabled={compactionActive}
          className={`p-1.5 rounded-md hover:bg-hover disabled:opacity-50 ${
            autoCompactionEnabled ? 'text-primary/80' : 'text-muted/50'
          }`}
          aria-label="Compact context"
        >
          <ArrowsClockwise size={12} className={compactionActive ? 'animate-spin' : ''} />
        </button>
      </Tooltip>
      {open && (
        <NodePopover
          popoverRef={popoverRef}
          pos={pos}
          portalTarget={portalTarget}
          width={200}
          bodyClassName="overflow-hidden"
        >
          <button
            onClick={() => { setOpen(false); onManualCompact() }}
            disabled={compactionActive}
            className="w-full text-left px-3 py-2 text-[12px] text-primary hover:bg-hover disabled:opacity-50"
          >
            Compact now
          </button>
          <div className="border-t border-subtle">
            <button
              onClick={() => onToggleAutoCompaction()}
              className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-primary hover:bg-hover"
            >
              <span>Auto-compact</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                autoCompactionEnabled ? 'bg-agent/20 text-agent-light' : 'bg-hover text-muted'
              }`}>
                {autoCompactionEnabled ? 'on' : 'off'}
              </span>
            </button>
          </div>
        </NodePopover>
      )}
    </>
  )
}

// -----------------------------------------------------------------------------
// Stats chip — single-glance % of context used, full breakdown on hover.
// -----------------------------------------------------------------------------

function ContextRing({ percent, size = 14, stroke = 1.5 }: { percent: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const filled = circ * (Math.min(percent, 100) / 100)
  const color = percent > 85 ? 'var(--git-deleted)' : percent > 65 ? 'var(--activity-orange)' : 'currentColor'
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="opacity-20" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeDasharray={`${filled} ${circ - filled}`} strokeLinecap="round" />
    </svg>
  )
}

function StatsChip({
  stats,
}: {
  stats: AgentSessionStats | null
}) {
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const { open, setOpen, popoverRef, pos, portalTarget } = useNodePopover(
    btnRef,
    (r) => ({ top: r.top - 6, left: r.left }),
  )
  if (!stats) return null
  const ctx = stats.contextUsage
  const ctxTokens = ctx?.tokens ?? null
  const ctxWindow = ctx?.contextWindow ?? null
  const ctxKnown = ctxTokens != null && ctxWindow != null && ctxWindow > 0
  const pctRaw =
    ctx?.percent != null
      ? ctx.percent
      : ctxKnown
      ? (ctxTokens! / ctxWindow!) * 100
      : null
  const pctRounded = pctRaw != null ? Math.round(pctRaw) : null
  const tone =
    pctRounded == null
      ? 'text-muted/70'
      : pctRounded > 85
      ? 'text-danger'
      : pctRounded > 65
      ? 'text-warning'
      : 'text-muted/70'
  const fmtCost = (c: number) =>
    c >= 1 ? `$${c.toFixed(2)}` : c >= 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(4)}`
  const barPct = pctRounded ?? 0
  const barColor = barPct > 85 ? 'bg-danger' : barPct > 65 ? 'bg-warning' : 'bg-agent-light'
  return (
    <>
      <Tooltip label="Conversation stats" placement="top">
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] font-mono ${tone} hover:bg-hover`}
          aria-label="Conversation stats"
        >
          {pctRounded != null ? <ContextRing percent={pctRounded} /> : <span>-</span>}
        </button>
      </Tooltip>
      {open && (
        <NodePopover
          popoverRef={popoverRef}
          pos={pos}
          portalTarget={portalTarget}
          width={260}
          bodyClassName="text-[11.5px] text-primary font-mono"
        >
          <div className="px-3 pt-3 pb-2 border-b border-subtle">
            <div className="flex justify-between items-baseline mb-1.5">
              <span className="text-muted text-[10px] uppercase tracking-wider font-semibold">Context window</span>
              <span>
                {ctxTokens != null ? formatTokensShort(ctxTokens) : '-'}
                {ctxWindow ? <span className="text-muted"> / {formatTokensShort(ctxWindow)}</span> : ''}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-hover-strong overflow-hidden">
              <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${barPct}%` }} />
            </div>
          </div>
          <div className="px-3 pt-2 pb-2 border-b border-subtle space-y-1">
            <div className="text-muted text-[10px] uppercase tracking-wider font-semibold mb-1">Billed tokens</div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Input</span>
              <span>{formatTokensShort(stats.tokens.input)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Output</span>
              <span>{formatTokensShort(stats.tokens.output)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Cache read</span>
              <span>{formatTokensShort(stats.tokens.cacheRead)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted">Cache write</span>
              <span>{formatTokensShort(stats.tokens.cacheWrite)}</span>
            </div>
          </div>
          <div className="px-3 py-2 flex justify-between gap-3">
            <span className="text-muted">Total cost</span>
            <span>{fmtCost(stats.cost)}</span>
          </div>
        </NodePopover>
      )}
    </>
  )
}

function formatTokensShort(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

// -----------------------------------------------------------------------------
// Slash command popup
// -----------------------------------------------------------------------------

const SOURCE_LABEL: Record<AgentSlashCommand['source'], string> = {
  skill: 'Skill',
  prompt: 'Prompt',
  extension: 'Command',
}

const SOURCE_COLOR: Record<AgentSlashCommand['source'], string> = {
  skill: 'text-agent-light bg-agent/10',
  prompt: 'text-muted bg-hover',
  extension: 'text-muted bg-hover',
}

function SlashPopup({
  commands,
  selectedIdx,
  onPick,
  onHover,
}: {
  commands: AgentSlashCommand[]
  selectedIdx: number
  onPick: (cmd: AgentSlashCommand) => void
  onHover: (idx: number) => void
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1.5 max-h-[240px] overflow-y-auto rounded-xl border border-strong bg-surface-4/98 backdrop-blur-xl shadow-[0_12px_32px_var(--shadow-node)] z-20">
      {commands.map((cmd, i) => {
        const active = i === selectedIdx
        return (
          <button
            key={`${cmd.source}-${cmd.name}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => { e.preventDefault(); onPick(cmd) }}
            className={`w-full text-left px-3 py-2 flex items-start gap-2 ${
              active ? 'bg-hover-strong' : 'hover:bg-hover'
            }`}
          >
            <span className={`shrink-0 mt-[1px] px-1.5 py-[1px] rounded text-[9px] uppercase tracking-wider font-semibold ${SOURCE_COLOR[cmd.source]}`}>
              {SOURCE_LABEL[cmd.source]}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-primary font-mono truncate">/{cmd.name}</div>
              {cmd.description && (
                <div className="text-[11px] text-muted truncate">{cmd.description}</div>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
