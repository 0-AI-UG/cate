// Terminal views in the app (`terminal.*` in the core API). Each follows its
// panel's session for the live PTY and binds to it with `bindTerminal`, the
// binding the desktop view uses, behind an `XtermLike` whose screen is the
// app's native terminal: output goes over the bridge as `terminal.event`s,
// acknowledged once the app has drawn it. Like every view, it draws the PTY's
// grid and reports the grid it holds, which the PTY takes while it fits this
// view.

import type { WorkspaceConnection, SessionHandle } from '@client/connections'
import type { TerminalSnapshot } from '@panels/terminal/contract'
import { bindTerminal, type TerminalBinding, type XtermLike } from '@services/terminal/client'
import { bytesToBase64 } from '@workspace/files/contract'
import type { MobileBridge, MobileTerminalEvent } from '../contract'
import type { MobileClient } from './boot'

type Grid = { cols: number; rows: number }
type Event = MobileTerminalEvent extends infer E ? E extends unknown ? Omit<E, 'terminalId'> : never : never

interface OpenTerminal {
  input(data: string): void
  /** The grid the view holds changed. */
  resize(cols: number, rows: number): void
  /** Fits the PTY to this view. */
  fit(): void
  close(): void
}

export interface MobileTerminals {
  open(params: { terminalId: string; workspaceId: string; panelId: string; cols: number; rows: number }): void
  get(terminalId: string): OpenTerminal | undefined
}

function stateText(snapshot: TerminalSnapshot): string | null {
  switch (snapshot.status) {
    case 'starting': return 'Starting…'
    case 'running': return null
    case 'exited': return snapshot.exitCode === null ? 'The process exited.' : `The process exited with code ${snapshot.exitCode}.`
    case 'failed': return snapshot.error ?? 'The terminal could not start.'
  }
}

export function createMobileTerminals(client: MobileClient, bridge: MobileBridge): MobileTerminals {
  const open = new Map<string, OpenTerminal>()
  const encoder = new TextEncoder()

  function openTerminal(params: { terminalId: string; workspaceId: string; panelId: string; cols: number; rows: number }): OpenTerminal {
    const { terminalId, workspaceId, panelId } = params
    let held: Grid = { cols: params.cols, rows: params.rows }
    let pty: Grid | null = null
    let fitted = false
    let closed = false
    const emit = (event: Event) => closed
      ? Promise.resolve(null)
      : bridge('terminal.event', { terminalId, ...event } as MobileTerminalEvent)
    const dataListeners = new Set<(data: string) => void>()
    // The app's terminal always has the PTY's grid.
    const screen: XtermLike = {
      get cols() { return pty?.cols ?? held.cols },
      get rows() { return pty?.rows ?? held.rows },
      write(data, callback) {
        const bytes = typeof data === 'string' ? encoder.encode(data) : data
        void emit({ kind: 'output', data: bytesToBase64(bytes) }).then(() => callback?.(), () => {})
      },
      reset() { void emit({ kind: 'reset' }).catch(() => {}) },
      onData(listener) {
        dataListeners.add(listener)
        return { dispose: () => { dataListeners.delete(listener) } }
      },
      // Only the PTY resizes it, and the binding reports `held` instead.
      onResize: () => ({ dispose() {} }),
    }
    let told = ''
    const tell = () => {
      if (!pty) return
      const event = { kind: 'size' as const, ...pty, fitted }
      const key = JSON.stringify(event)
      if (key === told) return
      told = key
      void emit(event).catch(() => {})
    }

    // The panel's session names the live PTY; a restart names a new one.
    let connection: WorkspaceConnection | null = null
    let session: SessionHandle<TerminalSnapshot> | null = null
    let offSession: (() => void) | null = null
    let ptyId: string | null = null
    let binding: TerminalBinding | null = null
    let lastState = ''

    const unbind = () => {
      binding?.dispose()
      binding = null
      ptyId = null
    }
    const update = () => {
      const snapshot = session?.getSnapshot()?.snapshot
      if (!snapshot || !connection) return
      const state = { kind: 'state' as const, status: snapshot.status, text: stateText(snapshot) }
      const key = JSON.stringify(state)
      if (key !== lastState) {
        lastState = key
        void emit(state).catch(() => {})
      }
      if (snapshot.ptyId === ptyId) return
      unbind()
      ptyId = snapshot.ptyId
      if (!ptyId) return
      binding = bindTerminal({
        terminal: screen,
        process: connection.runtime.process,
        id: ptyId,
        size: () => held,
        onSize: (size) => {
          pty = { cols: size.cols, rows: size.rows }
          fitted = size.fitted
          tell()
        },
      })
    }
    const follow = () => {
      const next = client.connections.get(workspaceId) ?? null
      if (next === connection) return
      unbind()
      offSession?.()
      session?.release()
      offSession = null
      session = null
      connection = next
      if (!connection) return
      session = connection.subscribeSession<TerminalSnapshot>(panelId)
      offSession = session.subscribe(update)
      update()
    }
    const offConnections = client.connections.subscribe(follow)
    follow()

    return {
      input(data) { for (const listener of [...dataListeners]) listener(data) },
      resize(cols, rows) {
        if (cols === held.cols && rows === held.rows) return
        held = { cols, rows }
        binding?.resized()
      },
      fit() { binding?.fit() },
      close() {
        if (closed) return
        closed = true
        offConnections()
        unbind()
        offSession?.()
        session?.release()
      },
    }
  }

  return {
    open(params) {
      open.get(params.terminalId)?.close()
      const terminal = openTerminal(params)
      open.set(params.terminalId, {
        ...terminal,
        close() {
          terminal.close()
          open.delete(params.terminalId)
        },
      })
    },
    get: (terminalId) => open.get(terminalId),
  }
}
