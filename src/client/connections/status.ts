// What a connection's state means to the person, in words, and what they can
// do about it: one table every shell shows (how it shows it is its own). Each
// state that is not `connected` names its trouble and offers only actions that
// work for this connection: a runtime the transport cannot start is not
// offered a start.

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

/** What the person can do: resolve an incompatible runtime where the
 *  workspace says how, try again, start a stopped runtime, drop a local or
 *  machine entry from the list, forget a paired workspace, pair again, or
 *  open the workspace a folder is nested in. */
export type ConnectionRemedy = 'resolve' | 'retry' | 'start' | 'remove' | 'forget' | 'pair' | 'openNested'

export interface ConnectionStatus {
  /** A short heading. */
  title: string
  /** One or two sentences. */
  message: string
  /** In the order to offer them; the first is the main one. */
  remedies: ConnectionRemedy[]
}

export interface StatusContext {
  /** Dialing starts the runtime when nothing answers (`startsRuntime`). */
  startsRuntime: boolean
  now?: number
}

/** The folder of a dial error that says the workspace folder is gone. */
export function missingFolderOf(error: string | undefined): string | null {
  return /ENOENT[^,]*, realpath '([^']+)'/.exec(error ?? '')?.[1] ?? null
}

/** A dial error worth showing: one written for people (ssh, the bridge), not
 *  a socket path, errno or timing. */
function readableError(error: string | undefined): string | null {
  if (!error) return null
  if (/\bE[A-Z]{3,}\b|wss?:\/\/|\d+ ?ms\b|\.sock\b|\\\\\.\\pipe|did not answer at/.test(error)) return null
  return error.replace(/\.$/, '')
}

/** The state in words and what to do about it; null when connected. */
export function connectionStatus(state: ConnectionState, context: StatusContext): ConnectionStatus | null {
  const { startsRuntime, now } = context
  const unreachable: ConnectionRemedy[] = startsRuntime ? ['retry', 'remove'] : ['retry', 'forget']
  switch (state.kind) {
    case 'connecting':
      return { title: 'Connecting', message: startsRuntime ? 'Starting the workspace runtime.' : 'Connecting to the workspace.', remedies: [] }
    case 'offline': {
      const missing = missingFolderOf(state.error)
      if (missing) {
        return { title: 'Folder not found', message: `${missing} is not there any more. If it moved, open it from its new place.`, remedies: ['remove', 'retry'] }
      }
      const reason = readableError(state.error)
      if (state.lastSeen) {
        return { title: 'Offline', message: `Last connected ${relativeTime(state.lastSeen, now)}.${reason ? ` ${reason}.` : ''} Cate keeps trying.`, remedies: unreachable }
      }
      return startsRuntime
        ? { title: 'Could not start', message: `The workspace runtime did not start${reason ? `: ${reason}` : ''}. Cate keeps trying.`, remedies: unreachable }
        : { title: 'Not reachable', message: `The workspace did not answer${reason ? `: ${reason}` : ''}. Its machine may be off or offline. Cate keeps trying.`, remedies: unreachable }
    }
    case 'incompatible':
      return { title: 'Runtime out of date', message: `The workspace runtime (${state.runtimeVersion}) needs an update.`, remedies: ['resolve'] }
    case 'refused':
      if (state.nestedIn) return { title: 'Already open', message: state.message, remedies: ['openNested', 'retry', 'remove'] }
      if (state.unpaired) {
        return { title: 'Not paired', message: 'This device is not paired with the workspace any more. Pair it again with a new code, or forget the workspace.', remedies: ['pair', 'forget'] }
      }
      return { title: 'Connection refused', message: state.message, remedies: ['retry'] }
    case 'stopped':
      return startsRuntime
        ? { title: 'Runtime stopped', message: 'The workspace runtime was stopped. Its terminals and agents have ended.', remedies: ['start'] }
        : { title: 'Runtime stopped', message: 'The workspace runtime was stopped on its machine. It runs again once someone opens the workspace there.', remedies: ['retry', 'forget'] }
    default:
      return null
  }
}
