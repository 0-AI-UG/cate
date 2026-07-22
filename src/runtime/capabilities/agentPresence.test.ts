// =============================================================================
// Agent presence tracker — hook-anchored pid registry. These tests pin the
// invariant the presence redesign exists for: detection follows the hook
// post's process LINEAGE, never the pty's tree topology — an agent detached
// from the pty (tmux/screen pane, setsid, nohup) is present exactly like a
// direct child, and an agent whose hooks never speak is absent.
// =============================================================================

import { describe, expect, test, vi } from 'vitest'
import { createAgentPresenceTracker } from './agentPresence'
import type { ProcTree } from './procfs'

/** Build a ProcTree from [pid, ppid, comm] rows (same fact set `ps -axo
 *  pid=,ppid=,comm=` yields). */
function tree(rows: Array<[number, number, string]>): ProcTree {
  const nameByPid = new Map<number, string>()
  const childrenByPid = new Map<number, number[]>()
  for (const [pid, ppid, comm] of rows) {
    nameByPid.set(pid, comm)
    const kids = childrenByPid.get(ppid)
    if (kids) kids.push(pid)
    else childrenByPid.set(ppid, [pid])
  }
  return { nameByPid, childrenByPid }
}

// The tmux shape that motivated all of this: the pty's shell has ONE child
// (the tmux client, no descendants); the agent lives under the tmux SERVER,
// a separate daemonized tree. claude spawned the hook bridge via sh; the
// bridge posts ppid=41 (the sh).
const TMUX_TREE = tree([
  [10, 1, 'zsh'], // the pty shell
  [20, 10, 'tmux'], // tmux client — no children, the old scan's dead end
  [30, 1, 'tmux'], // tmux server (daemonized)
  [31, 30, 'zsh'], // pane shell
  [40, 31, 'claude'], // the agent
  [41, 40, 'sh'], // claude's hook-command shell
])

const T = 'pty-1'

function makeTracker(snapshotTree: ProcTree, opts: { alive?: (pid: number) => boolean } = {}) {
  const snapshot = vi.fn(async () => snapshotTree)
  const tracker = createAgentPresenceTracker({ snapshot, isAlive: opts.alive ?? (() => true) })
  return { tracker, snapshot }
}

describe('notePost → presenceFor', () => {
  test('resolves the agent through arbitrary ancestry — the pty tree plays no part', async () => {
    const { tracker } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'claude-code', 41) // bridge's ppid: the sh layer
    expect(tracker.presenceFor(T, TMUX_TREE)).toEqual({ agentName: 'Claude Code', agentPresent: true })
  })

  test('an in-process agent posting its own pid registers directly', async () => {
    const t = tree([[10, 1, 'zsh'], [50, 10, 'pi']])
    const { tracker } = makeTracker(t)
    await tracker.notePost(T, 'pi', 50)
    expect(tracker.presenceFor(T, t)).toEqual({ agentName: 'PI Agent', agentPresent: true })
  })

  test('no hook post → never present, whatever the process tree shows', () => {
    // The one-authority rule: a direct-child agent that never spoke hooks
    // reads absent (the old child-scan behaviour is deliberately gone).
    const t = tree([[10, 1, 'zsh'], [60, 10, 'claude']])
    const { tracker } = makeTracker(t)
    expect(tracker.presenceFor(T, t)).toEqual({ agentName: null, agentPresent: false })
  })

  test('falling edge: registered pid gone from the snapshot → absent and deregistered', async () => {
    const { tracker } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'claude-code', 41)

    const without = tree([[10, 1, 'zsh'], [20, 10, 'tmux'], [30, 1, 'tmux'], [31, 30, 'zsh']])
    expect(tracker.presenceFor(T, without).agentPresent).toBe(false)
    // Deregistered, not just hidden: the pid reappearing later (recycled by
    // an unrelated process) must not resurrect presence.
    expect(tracker.presenceFor(T, TMUX_TREE).agentPresent).toBe(false)
  })

  test('pid reuse: same pid with a different comm reads absent', async () => {
    const { tracker } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'claude-code', 41)

    const recycled = tree([[10, 1, 'zsh'], [40, 1, 'vim']])
    expect(tracker.presenceFor(T, recycled).agentPresent).toBe(false)
  })

  test('no matching ancestor → nothing registered (never latch onto a shell or the tmux server)', async () => {
    const noAgent = tree([[10, 1, 'zsh'], [30, 1, 'tmux'], [31, 30, 'zsh'], [41, 31, 'sh']])
    const { tracker } = makeTracker(noAgent)
    await tracker.notePost(T, 'claude-code', 41)
    expect(tracker.presenceFor(T, noAgent).agentPresent).toBe(false)
  })

  test('untrusted input: unknown agent id, non-integer / non-positive pids are ignored without a snapshot', async () => {
    const { tracker, snapshot } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'not-an-agent' as never, 41)
    await tracker.notePost(T, 'claude-code', undefined)
    await tracker.notePost(T, 'claude-code', 0)
    await tracker.notePost(T, 'claude-code', -40) // kill(-pid) addresses a GROUP
    await tracker.notePost(T, 'claude-code', 40.5)
    expect(snapshot).not.toHaveBeenCalled()
    expect(tracker.presenceFor(T, TMUX_TREE).agentPresent).toBe(false)
  })

  test('fast path: a live registration skips the snapshot; a dead one re-resolves (relaunch)', async () => {
    let claudeAlive = true
    const { tracker, snapshot } = makeTracker(TMUX_TREE, { alive: () => claudeAlive })
    await tracker.notePost(T, 'claude-code', 41)
    expect(snapshot).toHaveBeenCalledTimes(1)

    // Per-tool-call event burst: no further snapshots while the pid lives.
    await tracker.notePost(T, 'claude-code', 41)
    await tracker.notePost(T, 'claude-code', 41)
    expect(snapshot).toHaveBeenCalledTimes(1)

    // The agent exited and a NEW claude (pid 70) launched in the same
    // terminal: the stale registration must not swallow the fresh lineage.
    claudeAlive = false
    const relaunched = tree([[10, 1, 'zsh'], [70, 10, 'claude'], [71, 70, 'sh']])
    const t2 = createAgentPresenceTracker({ snapshot: async () => relaunched, isAlive: () => false })
    await t2.notePost(T, 'claude-code', 71)
    await t2.notePost(T, 'claude-code', 71) // isAlive=false forces re-resolve; idempotent
    expect(t2.presenceFor(T, relaunched)).toEqual({ agentName: 'Claude Code', agentPresent: true })
  })

  test('a different agent in the same terminal replaces the registration', async () => {
    const both = tree([[10, 1, 'zsh'], [40, 10, 'claude'], [41, 40, 'sh'], [80, 10, 'codex'], [81, 80, 'sh']])
    const { tracker } = makeTracker(both)
    await tracker.notePost(T, 'claude-code', 41)
    await tracker.notePost(T, 'codex', 81)
    expect(tracker.presenceFor(T, both)).toEqual({ agentName: 'Codex', agentPresent: true })
  })

  test('a cyclic parent chain terminates', async () => {
    // Corrupt/racy snapshots can produce cycles; the walk must not spin.
    const cyclic = tree([[41, 42, 'sh'], [42, 41, 'sh']])
    const { tracker } = makeTracker(cyclic)
    await tracker.notePost(T, 'claude-code', 41)
    expect(tracker.presenceFor(T, cyclic).agentPresent).toBe(false)
  })

  test('drop() clears the registration (terminal teardown)', async () => {
    const { tracker } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'claude-code', 41)
    tracker.drop(T)
    expect(tracker.presenceFor(T, TMUX_TREE).agentPresent).toBe(false)
  })

  test('registrations are per terminal', async () => {
    const { tracker } = makeTracker(TMUX_TREE)
    await tracker.notePost(T, 'claude-code', 41)
    expect(tracker.presenceFor('pty-other', TMUX_TREE).agentPresent).toBe(false)
    expect(tracker.presenceFor(T, TMUX_TREE).agentPresent).toBe(true)
  })
})
