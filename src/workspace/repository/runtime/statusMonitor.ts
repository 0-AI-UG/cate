// One status monitor per checkout, alive while anyone subscribes. It polls a
// cheap probe (branch, tracked dirty flag, local branches) adaptively: 2 s
// right after a change, doubling up to 30 s while nothing moves. A probe
// change, a file change or a kick after a git write reads the full snapshot;
// subscribers get it when it differs from the last one.

import type { Logger } from '@kernel/log/contract'
import { checkoutPathKey, type RepoStatus } from '../contract'
import type { StatusProbe } from './git'

export const POLL_MIN_MS = 2_000
export const POLL_MAX_MS = 30_000
const FS_DEBOUNCE_MS = 150

export interface StatusMonitorDeps {
  probe(cwd: string): Promise<StatusProbe>
  snapshot(cwd: string): Promise<RepoStatus>
  /** File watcher of the checkout; changes read a fresh snapshot. */
  watch?: (dir: string, onChange: () => void) => () => void
  /** Every new snapshot, after subscribers got it. */
  onSnapshot?: (cwd: string, status: RepoStatus) => void
  log?: Logger
}

export interface StatusMonitors {
  /** The listener gets the last snapshot right away when there is one. */
  subscribe(cwd: string, listener: (status: RepoStatus) => void): () => void
  /** Read a fresh snapshot now and reset the back-off: one checkout, or all. */
  kick(cwd?: string): void
  current(cwd: string): RepoStatus | undefined
  dispose(): void
}

interface Monitor {
  cwd: string
  listeners: Set<(status: RepoStatus) => void>
  timer: ReturnType<typeof setTimeout> | null
  fsTimer: ReturnType<typeof setTimeout> | null
  delay: number
  /** Bumped by every tick and by teardown; a tick whose epoch moved on drops
   *  its result. */
  epoch: number
  probeKey: string | null
  snapshotKey: string | null
  last: RepoStatus | undefined
  unwatch: (() => void) | null
  closed: boolean
}

export function createStatusMonitors(deps: StatusMonitorDeps): StatusMonitors {
  const monitors = new Map<string, Monitor>()

  const schedule = (m: Monitor): void => {
    if (m.timer) clearTimeout(m.timer)
    m.timer = m.closed ? null : setTimeout(() => void tick(m, false), m.delay)
  }

  async function tick(m: Monitor, force: boolean): Promise<void> {
    if (m.timer) clearTimeout(m.timer)
    m.timer = null
    if (m.closed) return
    const epoch = ++m.epoch
    const stale = () => m.closed || m.epoch !== epoch
    let changed = false
    try {
      let probeKey: string
      try {
        probeKey = JSON.stringify(await deps.probe(m.cwd))
      } catch {
        // Not a repo (yet), or git failed: back off until that changes.
        probeKey = 'unavailable'
      }
      if (stale()) return
      if (force || !m.last || probeKey !== m.probeKey) {
        m.probeKey = probeKey
        const snapshot = await deps.snapshot(m.cwd)
        if (stale()) return
        const key = JSON.stringify(snapshot)
        if (key !== m.snapshotKey) {
          m.snapshotKey = key
          m.last = snapshot
          changed = true
          for (const listener of [...m.listeners]) listener(snapshot)
          deps.onSnapshot?.(m.cwd, snapshot)
        }
      }
    } catch (err) {
      deps.log?.debug('status poll failed for %s: %s', m.cwd, err instanceof Error ? err.message : String(err))
    }
    if (stale()) return
    m.delay = changed ? POLL_MIN_MS : Math.min(m.delay * 2, POLL_MAX_MS)
    schedule(m)
  }

  function kickMonitor(m: Monitor): void {
    m.delay = POLL_MIN_MS
    void tick(m, true)
  }

  function close(m: Monitor): void {
    m.closed = true
    m.epoch++
    if (m.timer) clearTimeout(m.timer)
    if (m.fsTimer) clearTimeout(m.fsTimer)
    m.timer = m.fsTimer = null
    m.unwatch?.()
    m.unwatch = null
    monitors.delete(checkoutPathKey(m.cwd))
  }

  return {
    subscribe(cwd, listener) {
      const key = checkoutPathKey(cwd)
      let m = monitors.get(key)
      if (!m) {
        const created: Monitor = {
          cwd,
          listeners: new Set(),
          timer: null,
          fsTimer: null,
          delay: POLL_MIN_MS,
          epoch: 0,
          probeKey: null,
          snapshotKey: null,
          last: undefined,
          unwatch: null,
          closed: false,
        }
        monitors.set(key, created)
        created.unwatch = deps.watch?.(cwd, () => {
          if (created.closed || created.fsTimer) return
          created.fsTimer = setTimeout(() => {
            created.fsTimer = null
            if (!created.closed) kickMonitor(created)
          }, FS_DEBOUNCE_MS)
        }) ?? null
        m = created
        void tick(created, true)
      }
      const monitor = m
      monitor.listeners.add(listener)
      if (monitor.last) listener(monitor.last)
      return () => {
        if (!monitor.listeners.delete(listener)) return
        if (monitor.listeners.size === 0) close(monitor)
      }
    },
    kick(cwd) {
      if (cwd === undefined) {
        for (const m of monitors.values()) kickMonitor(m)
        return
      }
      const m = monitors.get(checkoutPathKey(cwd))
      if (m) kickMonitor(m)
    },
    current(cwd) {
      return monitors.get(checkoutPathKey(cwd))?.last
    },
    dispose() {
      for (const m of [...monitors.values()]) close(m)
    },
  }
}
