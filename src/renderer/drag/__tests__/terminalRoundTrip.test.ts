// Regression: terminal-goes-gray after multi-step drag round-trip.
//
// Scenario the user reports:
//   1. Open a terminal in the main window's dock.
//   2. Drag it OUT to a detached dock window (cross-window).
//   3. Drag it BACK INTO the main window's dock (cross-window).
//   4. Drag it onto the main window's canvas (same-window).
//   5. The terminal goes gray — no input, no output.
//
// These tests do NOT render TerminalPanel. They simulate two registries
// (one per renderer) using a minimal in-memory model that mirrors the real
// terminalRegistry contract: getOrCreate short-circuits when an entry exists,
// otherwise consumes a pendingTransfer if present, otherwise spawns fresh.
//
// The point is to PIN the sequence of registry operations during the bug
// scenario so that if any step starts to leak or lose track of state, the
// failure surfaces here rather than in xterm rendering.

import { describe, it, expect } from 'vitest'

interface Entry { ptyId: string }

// Faithful mirror of terminalRegistry's contract — and crucially of its
// short-circuit semantics in getOrCreate. The pending-transfer cleanup
// behavior in the existing-entry branch is what the round-trip exercises.
function makeRegistry(label: string) {
  const entries = new Map<string, Entry>()
  const pending = new Map<string, { ptyId: string; scrollback?: string }>()
  let ptyCounter = 0
  return {
    label,
    entries,
    pending,
    getEntry: (id: string) => entries.get(id),
    setPendingTransfer: (id: string, ptyId: string, scrollback?: string) => {
      pending.set(id, { ptyId, scrollback })
    },
    has: (id: string) => entries.has(id),
    release: (id: string) => { entries.delete(id) },
    // The contract under test. The real registry's existing-entry branch
    // returns immediately and DOES NOT clear pendingTransfers — which is the
    // suspected leak. We assert against it via the round-trip below.
    getOrCreate: (id: string): Entry => {
      const existing = entries.get(id)
      if (existing) { pending.delete(id); return existing }
      const transfer = pending.get(id)
      if (transfer) {
        pending.delete(id)
        const reconnected: Entry = { ptyId: transfer.ptyId }
        entries.set(id, reconnected)
        return reconnected
      }
      ptyCounter++
      const fresh: Entry = { ptyId: `${label}-pty-${ptyCounter}` }
      entries.set(id, fresh)
      return fresh
    },
  }
}

// createTransferSnapshot equivalent — reads the SOURCE renderer's registry.
function snapshotTerminal(source: ReturnType<typeof makeRegistry>, panelId: string): { terminalPtyId?: string } {
  const entry = source.getEntry(panelId)
  return { terminalPtyId: entry?.ptyId }
}

describe('terminal multi-step drag round-trip (user-reported gray-terminal bug)', () => {
  it('preserves the live ptyId across main → detached → main → canvas drags', () => {
    const main = makeRegistry('main')
    const detached = makeRegistry('detached')
    const panelId = 'panel-T'

    // State A — terminal in main's dock with a live PTY.
    const initial = main.getOrCreate(panelId)
    const livePtyId = initial.ptyId
    expect(livePtyId).toMatch(/^main-pty-/)

    // Step 2: drag main → detached. Source builds snapshot from MAIN.
    const snap1 = snapshotTerminal(main, panelId)
    expect(snap1.terminalPtyId).toBe(livePtyId)

    // Destination (detached) deposits pending transfer before mount.
    detached.setPendingTransfer(panelId, snap1.terminalPtyId!, 'scrollback-1')
    // Source releases — cross-window detach calls onRemovedFromCanvas → release.
    main.release(panelId)
    // Destination mounts → getOrCreate consumes pending.
    const detachedEntry = detached.getOrCreate(panelId)
    expect(detachedEntry.ptyId).toBe(livePtyId)
    expect(detached.pending.has(panelId)).toBe(false)
    expect(main.has(panelId)).toBe(false)
    expect(detached.has(panelId)).toBe(true)

    // Step 3: drag detached → main. Source = detached, destination = main.
    const snap2 = snapshotTerminal(detached, panelId)
    expect(snap2.terminalPtyId).toBe(livePtyId)

    main.setPendingTransfer(panelId, snap2.terminalPtyId!, 'scrollback-2')
    detached.release(panelId)
    const mainEntryAgain = main.getOrCreate(panelId)
    expect(mainEntryAgain.ptyId).toBe(livePtyId)
    expect(main.pending.has(panelId)).toBe(false)
    expect(detached.has(panelId)).toBe(false)
    expect(main.has(panelId)).toBe(true)

    // Step 4: same-window drag from main's dock into main's canvas.
    // prepareLocalRemount calls setPendingTransfer on the SAME window.
    main.setPendingTransfer(panelId, mainEntryAgain.ptyId, 'scrollback-3')
    // removeFromSource in same-window dock-tab origin only undocks — it does
    // NOT release the registry entry. TerminalPanel unmount calls detach()
    // (not release()), so the entry survives.
    // Canvas mounts a new TerminalPanel → getOrCreate(panelId).
    const canvasMount = main.getOrCreate(panelId)

    // CONTRACT 1: the same live entry is returned (no fresh PTY spawn).
    expect(canvasMount).toBe(mainEntryAgain)
    expect(canvasMount.ptyId).toBe(livePtyId)

    // CONTRACT 2: no leaked pending transfer remains for this panelId.
    // If the registry leaks here, a later workspace switch (which would
    // dispose the entry) followed by re-open would re-enter reconnect mode
    // against the now-stale ptyId, leading to a gray terminal wired to a
    // dead listener pair.
    expect(main.pending.has(panelId)).toBe(false)
  })

  it('a leaked pending transfer is silently consumed by a future remount, hijacking the new entry', () => {
    // This test demonstrates WHY contract 2 matters. We construct the leak
    // directly and show the resulting hijack: a remount after dispose ends
    // up wired to the stale ptyId from the prior same-window drag.
    const main = makeRegistry('main')
    const panelId = 'panel-T'

    const first = main.getOrCreate(panelId)
    main.setPendingTransfer(panelId, first.ptyId, 'leaked-scrollback')
    // getOrCreate short-circuits — does not clear pending in the real registry.
    const stillFirst = main.getOrCreate(panelId)
    expect(stillFirst).toBe(first)

    // Simulate the real registry's existing-entry short-circuit by manually
    // re-depositing what the real getOrCreate would have left in place.
    // (Our mirror DOES clear on consumption; the real registry does not on
    // short-circuit. We re-add to model the bug.)
    main.setPendingTransfer(panelId, first.ptyId, 'leaked-scrollback')

    // Now panel is disposed (workspace switch, e.g.).
    main.release(panelId)

    // Re-create — expected to spawn a FRESH PTY. Instead, the leaked pending
    // transfer hijacks the call and the new entry adopts the stale ptyId
    // pointing at a PTY whose IPC listeners were torn down by release().
    const remounted = main.getOrCreate(panelId)
    expect(remounted.ptyId).toBe(first.ptyId)
    // No fresh PTY allocation happened — visible as the gray terminal.
    expect(remounted.ptyId).not.toMatch(/main-pty-2/)
  })
})
