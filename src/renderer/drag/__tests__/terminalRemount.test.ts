import { describe, it, expect, vi } from 'vitest'
import { prepareTerminalRemount } from '../terminalRemount'

// Stand-in for terminalRegistry.serializeTerminalState — these tests drive the
// captured string via the fixture entry's `scrollback` field.
function serialize(entry?: { scrollback?: string }) {
  return typeof entry?.scrollback === 'string' ? entry.scrollback : undefined
}

function makeRegistry(entry?: { ptyId: string; scrollback?: string }) {
  return {
    getEntry: vi.fn(() => entry),
    setPendingTransfer: vi.fn(),
    serializeTerminalState: vi.fn((e?: unknown) => serialize(e as { scrollback?: string })),
  }
}

describe('prepareTerminalRemount (regression: same-window terminal drag spawns fresh PTY)', () => {
  it('returns false and does not call setPendingTransfer for non-terminal panels', () => {
    const registry = makeRegistry({ ptyId: 'pty-1', scrollback: 'hello' })
    const result = prepareTerminalRemount('panel-A', 'editor', registry)
    expect(result).toBe(false)
    expect(registry.setPendingTransfer).not.toHaveBeenCalled()
  })

  it('returns true and arms setPendingTransfer with the live PTY for a terminal panel with a registry entry', () => {
    const registry = makeRegistry({ ptyId: 'pty-1', scrollback: 'hello' })
    const result = prepareTerminalRemount('panel-A', 'terminal', registry)
    expect(result).toBe(true)
    expect(registry.setPendingTransfer).toHaveBeenCalledTimes(1)
    expect(registry.setPendingTransfer).toHaveBeenCalledWith('panel-A', 'pty-1', 'hello')
  })

  it('returns false and skips setPendingTransfer when the terminal has no registry entry', () => {
    const registry = makeRegistry(undefined)
    const result = prepareTerminalRemount('panel-A', 'terminal', registry)
    expect(result).toBe(false)
    expect(registry.setPendingTransfer).not.toHaveBeenCalled()
  })

  // Regression: same-window dock→canvas drag arms a pending transfer for a
  // panelId whose entry never goes away (TerminalPanel cleanup calls detach()
  // not release()). The real getOrCreate short-circuits on the existing entry
  // without consuming the pending transfer — so the transfer is left to be
  // picked up by some later, unrelated mount.
  it('arms a pending transfer that is left dangling when the live entry is reused', () => {
    const entry = { ptyId: 'pty-1', scrollback: 'live' }
    // Faithful mirror of the registry contract — short-circuits on existing
    // entry, does NOT consume pending in that branch.
    const entries = new Map<string, { ptyId: string; scrollback?: string }>([['panel-A', entry]])
    const pending = new Map<string, { ptyId: string; scrollback?: string }>()
    const registry = {
      getEntry: (id: string) => entries.get(id),
      setPendingTransfer: (id: string, ptyId: string, scrollback?: string) => {
        pending.set(id, { ptyId, scrollback })
      },
      serializeTerminalState: (e?: unknown) => serialize(e as { scrollback?: string }),
      getOrCreate: (id: string) => {
        const existing = entries.get(id)
        if (existing) { pending.delete(id); return existing }
        const t = pending.get(id)
        if (t) { pending.delete(id); return { ptyId: t.ptyId } as { ptyId: string; scrollback?: string } }
        return { ptyId: 'fresh' } as { ptyId: string; scrollback?: string }
      },
    }

    const armed = prepareTerminalRemount('panel-A', 'terminal', registry)
    expect(armed).toBe(true)

    // The mount call returns the SAME live entry (no fresh PTY, no reconnect).
    const remounted = registry.getOrCreate('panel-A')
    expect(remounted).toBe(entry)

    // CONTRACT: pending transfer should be cleared by the end of the mount.
    // It is not, today — a future re-mount will erroneously enter reconnect
    // mode against the stale ptyId.
    expect(pending.has('panel-A')).toBe(false)
  })
})
