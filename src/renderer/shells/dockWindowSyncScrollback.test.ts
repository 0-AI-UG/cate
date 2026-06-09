// Regression: a top-level terminal tab in a detached (dock) window loses its
// scrollback on restart. Root cause is a quit-time race — DockWindowShell's
// pre-quit flush fired the scrollback save IPC fire-and-forget and ACKed main
// immediately, so main reallyExit(0)'d before the .scrollback write landed. The
// fix makes the flush AWAIT the scrollback writes before ACKing.
//
// This test pins the await contract at the helper + flush-orchestration level:
//   - captureTerminalScrollbacks returns the in-flight save promises, and
//   - the flush sequence (await syncNow, THEN ack) must not ACK before the save
//     promise settles.

// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../lib/terminal/terminalRegistry', async () => {
  // Use the REAL serializeTerminalState so the helper produces genuine content;
  // only getEntry is stubbed to our fake entries (each carries a fake serialize
  // addon).
  const { serializeTerminalState } = await import('../lib/terminal/scrollbackCapture')
  return {
    terminalRegistry: {
      getEntry: (panelId: string) =>
        entries.get(panelId) as { ptyId: string } | undefined,
      serializeTerminalState,
    },
  }
})

// captureAndSaveScrollback delegates to window.electronAPI.terminalScrollbackSave;
// use the REAL helper so the promise it returns is the actual save promise.
import { captureTerminalScrollbacks } from './dockWindowSyncScrollback'
import type { PanelState } from '../../shared/types'

const entries = new Map<string, { ptyId: string; serializeAddon: { serialize: () => string } }>()

// A minimal fake entry whose serialize addon returns the given content.
function fakeTerminalEntry(ptyId: string, content: string) {
  return {
    ptyId,
    serializeAddon: { serialize: () => content },
  }
}

let resolveSave: (() => void) | undefined
let saveCalls: Array<[string, string]>

beforeEach(() => {
  entries.clear()
  resolveSave = undefined
  saveCalls = []
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      // A deferred save: resolves only when the test calls resolveSave(), so we
      // can prove the flush ACK waits for it.
      terminalScrollbackSave: vi.fn((key: string, content: string) => {
        saveCalls.push([key, content])
        return new Promise<void>((resolve) => { resolveSave = resolve })
      }),
      // cwd capture resolves immediately so the helper's await completes.
      terminalGetCwd: vi.fn(async (_ptyId: string) => '/work/cwd'),
    },
  })
})

describe('captureTerminalScrollbacks', () => {
  it('saves scrollback keyed by panelId + records cwd per terminal', async () => {
    entries.set('term-1', fakeTerminalEntry('pty-1', 'ls output'))
    const panels: Record<string, PanelState> = {
      'term-1': { id: 'term-1', type: 'terminal', title: 'T' } as PanelState,
      'ed-1': { id: 'ed-1', type: 'editor', title: 'E' } as PanelState,
    }

    const { terminalCwds, savePromises } = await captureTerminalScrollbacks(panels)

    // Scrollback is keyed by the STABLE panelId — not the ptyId.
    expect(saveCalls).toEqual([['term-1', 'ls output']])
    expect(savePromises).toHaveLength(1)
    expect(terminalCwds).toEqual({ 'term-1': '/work/cwd' })
  })

  it('skips terminals with no registry entry', async () => {
    const panels: Record<string, PanelState> = {
      'term-1': { id: 'term-1', type: 'terminal', title: 'T' } as PanelState,
    }
    // No entry registered for term-1 → nothing to capture.
    const { terminalCwds, savePromises } = await captureTerminalScrollbacks(panels)
    expect(terminalCwds).toEqual({})
    expect(savePromises).toHaveLength(0)
    expect(saveCalls).toEqual([])
  })
})

describe('pre-quit flush awaits the scrollback write before ACKing', () => {
  // Mirror DockWindowShell.onDockWindowFlushSync: await syncNow (which awaits the
  // save promises) THEN dockWindowFlushSyncDone(). The ACK must NOT fire while
  // the save is still pending — that is the exact race that drops scrollback.
  it('does not ACK until every scrollback save settles', async () => {
    entries.set('term-1', fakeTerminalEntry('pty-1', 'ls output'))
    const panels: Record<string, PanelState> = {
      'term-1': { id: 'term-1', type: 'terminal', title: 'T' } as PanelState,
    }

    const ack = vi.fn()

    // The shell's syncNow: capture + Promise.allSettled over the save promises.
    const syncNow = async (): Promise<void> => {
      const { savePromises } = await captureTerminalScrollbacks(panels)
      await Promise.allSettled(savePromises)
    }

    // The flush handler: await syncNow, THEN ack.
    const flush = syncNow().finally(() => ack())

    // Let the capture (incl. its cwd await) settle and issue the save IPC, which
    // has NOT resolved yet — so the ACK must still be pending.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(saveCalls).toHaveLength(1)
    expect(ack).not.toHaveBeenCalled()

    // Now the write completes — the ACK fires.
    resolveSave?.()
    await flush
    expect(ack).toHaveBeenCalledTimes(1)
  })
})
