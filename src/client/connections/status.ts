// What a connection's state means to the person, in words, and what they can
// do about it. Every shell shows these; how it shows them is its own.

import type { ConnectionState } from './connection'

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
    case 'stopped': return 'The workspace runtime was stopped. Its terminals and agents have ended.'
    default: return null
  }
}

const STATUS_TITLE: Partial<Record<ConnectionState['kind'], string>> = {
  connecting: 'Connecting',
  offline: 'Offline',
  incompatible: 'Runtime out of date',
  refused: 'Connection refused',
  stopped: 'Runtime stopped',
}

/** A short heading for a connection state that is not `connected`. */
export function connectionTitle(state: ConnectionState): string {
  return STATUS_TITLE[state.kind] ?? ''
}

/** What the person can do about a connection state: resolve an incompatible
 *  runtime where the workspace says how, retry an offline one, or start a
 *  stopped one again. */
export type ConnectionRemedy = 'resolve' | 'retry' | 'start'

export function connectionRemedy(state: ConnectionState): ConnectionRemedy | null {
  if (state.kind === 'incompatible') return 'resolve'
  if (state.kind === 'offline') return 'retry'
  if (state.kind === 'stopped') return 'start'
  return null
}
