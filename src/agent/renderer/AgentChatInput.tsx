// =============================================================================
// AgentChatInput — the bottom-of-thread composer for AgentPanel and everything
// that lives on its control row: the slash-command popup, the compact-context
// popover, and the context/cost stats chip. All state is driven from props;
// the only local state is transient UI (popover open, drag-over, slash index).
// =============================================================================

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Stop,
  PaperPlaneRight,
  ClipboardText,
  Spinner,
  ArrowsClockwise,
} from '@phosphor-icons/react'
import {
  ImageAttachButton,
  ImageChips,
  ThinkingLevelPicker,
  NodePopover,
  useNodePopover,
} from './AgentPanelChrome'
import type {
  AgentImageAttachment,
  AgentSlashCommand,
  AgentThinkingLevel,
} from '../../shared/types'
import { Tooltip } from '../../renderer/ui/Tooltip'

export function ChatInput({
  draft,
  onChange,
  onSubmit,
  onStop,
  disabled,
  running,
  textareaRef,
  commands,
  images,
  onAddImage,
  onRemoveImage,
  onPaste,
  onDrop,
  stats,
  thinkingLevel,
  onPickThinkingLevel,
  autoCompactionEnabled,
  onManualCompact,
  onToggleAutoCompaction,
  compactionActive,
  planModeActive,
  onTogglePlanMode,
  onSlashOpen,
  placeholder: placeholderOverride,
}: {
  draft: string
  onChange: (s: string) => void
  onSubmit: () => void
  onStop: () => void
  disabled: boolean
  running: boolean
  textareaRef: React.RefObject<HTMLTextAreaElement>
  commands: AgentSlashCommand[]
  images: AgentImageAttachment[]
  onAddImage: (img: AgentImageAttachment) => void
  onRemoveImage: (idx: number) => void
  onPaste: (e: React.ClipboardEvent) => void
  onDrop: (e: React.DragEvent) => void
  stats: import('../../shared/types').AgentSessionStats | null
  thinkingLevel: AgentThinkingLevel | null
  onPickThinkingLevel: (level: AgentThinkingLevel) => void
  autoCompactionEnabled: boolean
  onManualCompact: () => void
  onToggleAutoCompaction: () => void
  compactionActive: boolean
  planModeActive: boolean
  onTogglePlanMode: () => void
  /** Fired when the slash-command popup opens (draft starts a `/command`), so the
   *  parent can refresh the command list — picks up newly-installed skills
   *  without reopening the panel. */
  onSlashOpen?: () => void
  placeholder?: string
}) {
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [draft, textareaRef])

  // Slash popup is active when the draft starts with "/" and has no spaces
  // before the cursor — i.e. the user is still picking a command name.
  const slashMatch = useMemo(() => {
    if (!draft.startsWith('/')) return null
    if (draft.includes(' ') || draft.includes('\n')) return null
    return draft.slice(1).toLowerCase()
  }, [draft])

  // On the leading edge of a slash command (the user just typed "/"), ask the
  // parent to refresh the command list so freshly-installed skills/prompts show
  // up without reopening the panel. Fires once per open, not per keystroke.
  const slashWasOpen = useRef(false)
  useEffect(() => {
    const open = slashMatch != null
    if (open && !slashWasOpen.current) onSlashOpen?.()
    slashWasOpen.current = open
  }, [slashMatch, onSlashOpen])

  const filteredCommands = useMemo(() => {
    if (slashMatch == null) return []
    return commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch))
  }, [slashMatch, commands])

  const popupOpen = slashMatch != null && filteredCommands.length > 0
  const [selectedIdx, setSelectedIdx] = useState(0)
  useEffect(() => { setSelectedIdx(0) }, [slashMatch])

  const acceptCommand = (cmd: AgentSlashCommand): void => {
    // Insert "/<name> " so the user can immediately type the argument.
    onChange(`/${cmd.name} `)
    // Refocus textarea so they can keep typing.
    queueMicrotask(() => textareaRef.current?.focus())
  }

  const canSend = !disabled && (draft.trim().length > 0 || images.length > 0)
  const [dragOver, setDragOver] = useState(false)

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

  return (
    <div className="px-3 py-2 shrink-0">
      <div
        onDragEnter={(e) => {
          if (!acceptsDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }}
        onDragOver={(e) => {
          if (!acceptsDrag(e)) return
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(e) => {
          // Only clear when leaving the wrapper itself, not when moving between
          // children (relatedTarget would still be inside).
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
          setDragOver(false)
        }}
        onDrop={(e) => {
          if (!acceptsDrag(e)) return
          e.stopPropagation()
          setDragOver(false)
          onDrop(e)
        }}
        className={`relative rounded-2xl border bg-surface-3 transition-colors ${
          dragOver
            ? 'border-agent-light ring-2 ring-agent-light/40'
            : 'border-strong focus-within:border-agent/50'
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
        <ImageChips images={images} onRemove={onRemoveImage} />
        <textarea
          ref={textareaRef}
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
            }
          }}
          disabled={disabled || compactionActive}
          placeholder={
            compactionActive
              ? 'Compacting context…'
              : placeholderOverride ?? (running ? 'Steer the agent…' : 'Message the agent…')
          }
          rows={1}
          className="w-full bg-transparent px-3 py-2 text-[13px] text-primary outline-none resize-none placeholder:text-muted disabled:opacity-50"
          style={{ maxHeight: 160 }}
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <ImageAttachButton onPick={onAddImage} />
          <ThinkingLevelPicker level={thinkingLevel} onChange={onPickThinkingLevel} />
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
          <CompactButton
            onManualCompact={onManualCompact}
            onToggleAutoCompaction={onToggleAutoCompaction}
            autoCompactionEnabled={autoCompactionEnabled}
            compactionActive={compactionActive}
          />
          <StatsChip stats={stats} />
          <div className="flex-1" />
          {compactionActive ? (
            <Tooltip label="Compacting context…" placement="top">
              <div className="p-1.5 rounded-full bg-agent/40 text-white">
                <Spinner size={12} weight="bold" className="animate-spin" />
              </div>
            </Tooltip>
          ) : running ? (
            canSend ? (
              <Tooltip label="Steer" placement="top">
                <button
                  onClick={onSubmit}
                  className="p-1.5 rounded-full bg-agent hover:bg-agent-light text-white"
                  aria-label="Steer"
                >
                  <PaperPlaneRight size={12} weight="fill" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Stop" placement="top">
                <button
                  onClick={onStop}
                  className="p-1.5 rounded-full bg-agent hover:bg-agent-light text-white"
                  aria-label="Stop"
                >
                  <Stop size={12} weight="fill" />
                </button>
              </Tooltip>
            )
          ) : (
            <Tooltip label="Send" placement="top">
              <button
                onClick={onSubmit}
                disabled={!canSend}
                className="p-1.5 rounded-full bg-agent hover:bg-agent-light disabled:bg-[var(--surface-hover-strong)] disabled:text-muted text-white"
                aria-label="Send"
              >
                <PaperPlaneRight size={12} weight="fill" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
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
  const btnRef = useRef<HTMLButtonElement>(null)
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
  stats: import('../../shared/types').AgentSessionStats | null
}) {
  const btnRef = useRef<HTMLButtonElement>(null)
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
