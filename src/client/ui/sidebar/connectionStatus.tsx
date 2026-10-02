// A workspace's connection as the sidebar shows it, in the row's expand
// toggle: connecting, offline with when it was last seen, refused, or
// incompatible. An incompatible runtime is resolved in the
// RuntimeMismatchDialog; the toggle's popover opens that again (7.10).

import { useEffect, useRef, useState } from 'react'
import { ChevronRight as CaretRight } from 'lucide-react'
import { PopoverSurface, btn, useViewportPopoverPosition } from '@kernel/ui'
import { useConnectionState } from '@client/connections/ui'
import type { ConnectionState, WorkspaceConnection } from '@client/connections'
import { showRuntimeMismatch } from '../dialogs/RuntimeMismatchDialog'

/** "5 minutes ago", coarse. */
export function relativeTime(then: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/** One line describing a connection state, or null when there is nothing to say. */
export function connectionLabel(state: ConnectionState, now?: number): string | null {
  switch (state.kind) {
    case 'connecting': return 'Connecting'
    case 'offline':
      return state.lastSeen
        ? `Offline, last seen ${relativeTime(state.lastSeen, now)}${state.retrying ? '. Retrying.' : ''}`
        : `Not reachable${state.error ? `: ${state.error}` : ''}${state.retrying ? '. Retrying.' : ''}`
    case 'incompatible':
      return state.build ? 'The workspace runtime is out of date' : `The workspace runtime (${state.runtimeVersion}) needs an update`
    case 'refused': return state.message
    default: return null
  }
}

const STATUS_TITLE: Partial<Record<ConnectionState['kind'], string>> = {
  connecting: 'Connecting',
  offline: 'Offline',
  incompatible: 'Runtime out of date',
  refused: 'Connection refused',
}

/** A short heading for a connection state that is not `connected`. */
export function connectionTitle(state: ConnectionState): string {
  return STATUS_TITLE[state.kind] ?? ''
}

/** The dot color of a connection state. */
export function connectionDotClass(state: ConnectionState): string {
  const busy = state.kind === 'connecting' || (state.kind === 'offline' && state.retrying)
  if (state.kind === 'incompatible') return 'bg-amber-400'
  return busy ? 'bg-amber-400 animate-pulse motion-reduce:animate-none' : 'bg-red-500'
}

/** What the person can do about a connection state, if anything. */
export function connectionAction(connection: WorkspaceConnection | undefined, state: ConnectionState): { label: string; run: () => void } | null {
  if (!connection) return null
  if (state.kind === 'incompatible') return { label: 'Resolve…', run: () => showRuntimeMismatch(connection) }
  if (state.kind === 'offline') return { label: 'Retry now', run: () => connection.retryNow() }
  return null
}

/** A workspace row's expand toggle. While the connection is not connected it
 *  shows a status dot instead of the caret (the caret on row hover), and
 *  hovering it shows what is wrong with the action that fixes it. */
export function WorkspaceToggle({ connection, canExpand, expanded, onToggle }: {
  connection: WorkspaceConnection | undefined
  canExpand: boolean
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  const state = useConnectionState(connection)
  const label = connectionLabel(state)
  const trigger = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { pos, portalTarget } = useViewportPopoverPosition(trigger, open && !!label, (rect) => ({ left: rect.left, gap: 6 }), popoverRef)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  // Hover opens after a beat; leaving closes after one, so the pointer can
  // cross into the popover.
  const hover = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(next), delay)
  }

  const color = connectionDotClass(state)
  const caret = <CaretRight size={10} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
  const action = connectionAction(connection, state)

  return (
    <>
      <button
        ref={trigger}
        className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-muted hover:text-primary focus:outline-none"
        onClick={(e) => { e.stopPropagation(); if (canExpand) onToggle() }}
        onMouseEnter={() => hover(true, 250)}
        onMouseLeave={() => hover(false, 150)}
        aria-label={label ?? (canExpand ? (expanded ? 'Collapse workspace' : 'Expand workspace') : undefined)}
        disabled={!canExpand && !label}
      >
        {label ? (
          <>
            <span className={`w-2 h-2 rounded-full ${color} ${canExpand ? 'group-hover:hidden' : ''}`} />
            {canExpand && <span className="hidden group-hover:flex">{caret}</span>}
          </>
        ) : canExpand && caret}
      </button>
      {open && label && (
        <PopoverSurface popoverRef={popoverRef} pos={pos} portalTarget={portalTarget} width={240} className="p-3">
          <div
            role="status"
            className="flex flex-col gap-1.5 text-[12px]"
            onMouseEnter={() => hover(true, 0)}
            onMouseLeave={() => hover(false, 150)}
          >
            <span className="flex items-center gap-2 font-medium text-primary">
              <span className={`w-2 h-2 rounded-full ${color}`} />
              {connectionTitle(state)}
            </span>
            <span className="text-secondary leading-relaxed">{label}</span>
            {action && (
              <button
                type="button"
                className={`self-start mt-1 ${btn.secondary}`}
                onClick={(e) => { e.stopPropagation(); setOpen(false); action.run() }}
              >
                {action.label}
              </button>
            )}
          </div>
        </PopoverSurface>
      )}
    </>
  )
}

/** The connection's trouble as one line (the Runtime settings page). */
export function ConnectionNotice({ connection }: { connection: WorkspaceConnection | undefined }): JSX.Element | null {
  const state = useConnectionState(connection)
  if (!connection || (state.kind !== 'offline' && state.kind !== 'refused')) return null
  return (
    <div className="mx-1.5 mb-1 pl-7 pr-2 text-[12px] text-muted">
      {connectionLabel(state)}
    </div>
  )
}
