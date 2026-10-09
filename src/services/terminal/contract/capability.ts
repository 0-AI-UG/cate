import { channelStream, defineCapability, method, stream, type ChannelEvent } from '@kernel/rpc/contract'

export type TerminalActivity =
  | { type: 'idle' }
  | { type: 'running'; processName: string }

/** A command to run at spawn, resolved in the runtime by the resolver
 *  registered for `kind`. Built in: `command` (`{ executable, args }`, run in
 *  place of the shell) and `input` (`{ text }`, typed into the shell once it
 *  starts). Other modules (agents, T3) register their own kinds. */
export interface LaunchIntent {
  kind: string
  params?: unknown
}

export interface SpawnParams {
  cols: number
  rows: number
  /** Absolute; defaults to the workspace root. */
  cwd?: string
  /** Overrides the `defaultShellPath` setting. */
  shell?: string
  /** The panel the terminal belongs to: names its CLI token and its log. */
  panelId?: string
  launch?: LaunchIntent
  /** Shows the panel's saved screen above the new shell. */
  restore?: boolean
}

export interface SpawnResult {
  id: string
  pid: number
  /** The executable that runs: the resolved shell or the launch command. */
  shell: string
}

export interface TerminalStatus {
  id: string
  panelId: string | null
  pid: number
  shell: string
  alive: boolean
  exitCode: number | null
  activity: TerminalActivity
  /** Listening TCP ports anywhere in the PTY's process tree, ascending. */
  ports: number[]
  cwd: string | null
  /** SIGSTOPped by idle suspend. */
  suspended: boolean
  viewers: number
}

export type TerminalStatuses = Record<string, TerminalStatus>
/** A removed terminal is `null`. */
export type TerminalStatusChange = Record<string, TerminalStatus | null>

export interface AttachParams {
  id: string
  cols?: number
  rows?: number
  visible?: boolean
}

/** An attach starts with `size` (a live PTY only) and the serialized screen;
 *  live output follows as binary chunks (UTF-8) with nothing lost or repeated
 *  between. `size` comes again on every change: the PTY's grid (the output
 *  after it is at that grid) and whether the PTY fits this viewer. */
export type AttachEvent =
  | { kind: 'screen'; viewer: string; data: string; cols: number; rows: number }
  | { kind: 'size'; cols: number; rows: number; fitted: boolean }
  | { kind: 'exit'; code: number }

/** Why an attach ended. `lagged`: the viewer fell too far behind and was
 *  dropped; attach again for a fresh screen. */
export interface AttachEnd {
  reason: 'exit' | 'closed' | 'lagged'
  exitCode?: number
}

export interface ViewParams {
  id: string
  viewer: string
  cols?: number
  rows?: number
  visible?: boolean
  /** Fit the PTY to this viewer (the person's fit action): the PTY takes its
   *  size, and follows its resizes, until another viewer asks to fit. */
  fit?: boolean
}

export interface ReadResult {
  /** The alternate screen is active (a full-screen program runs). */
  alt: boolean
  text: string
}

export interface ScreenSnapshot {
  data: string
  cols: number
  rows: number
}

export const processCapability = defineCapability('process', {
  methods: {
    spawn: method<SpawnParams, SpawnResult>({ mutates: true }),
    /** Reports a viewer's size, visibility and activity. */
    view: method<ViewParams, void>(),
    /** Kills the PTY; the screen stays readable until `close`. */
    kill: method<{ id: string }, void>({ mutates: true }),
    /** Kills the PTY and forgets the terminal and its log. */
    close: method<{ id: string }, void>({ mutates: true }),
    cwd: method<{ id: string }, string | null>(),
    /** Screen and scrollback as text, the last `lines` lines when given. */
    read: method<{ id: string; lines?: number }, ReadResult>(),
    snapshot: method<{ id: string }, ScreenSnapshot>(),
    list: method<void, TerminalStatus[]>(),
  },
  streams: {
    attach: stream<AttachParams, AttachEvent, AttachEnd>({ bytes: true }),
    statuses: channelStream<void, TerminalStatuses, TerminalStatusChange>(),
  },
})

export type StatusEvent = ChannelEvent<TerminalStatuses, TerminalStatusChange>

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    process: typeof processCapability
  }
}
