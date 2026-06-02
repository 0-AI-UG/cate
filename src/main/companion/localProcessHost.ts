// =============================================================================
// localProcessHost — the local machine's ProcessHost. It wraps the shared,
// electron-free process capability (node-pty spawn/write/resize/kill) with the
// concerns that are inherently LOCAL and can't live in the portable capability:
//   - shell resolution via the main-process resolveShell (+ fallback notice)
//     and the login-shell env (minus npm/Electron vars)
//   - idle-suspend: SIGSTOP a terminal that's offscreen and silent past the
//     threshold, SIGCONT on input/visibility (POSIX-only, behind the user
//     setting). The remote daemon's ProcessHost simply doesn't do this, so the
//     terminal IPC layer no longer branches on local-vs-remote.
//   - process-group teardown (kill/quit/crash) so children (dev servers) die.
//
// shell.ts (local process monitor) and index.ts (crash cleanup) read the local
// pid / suspended state from here rather than from terminal.ts.
// =============================================================================

import { createProcessCapability } from '../../companion/capabilities/process'
import { resolveShell } from '../shellResolver'
import { getShellEnv } from '../shellEnv'
import { getSettingSync } from '../store'
import log from '../logger'
import type { ProcessHost } from './types'

interface IdleState {
  lastOutputAt: number
  visible: boolean
  suspended: boolean
}

const IDLE_SUSPEND_MS = 2 * 60_000
const IDLE_CHECK_INTERVAL_MS = 20_000

/** ProcessHost plus the local-only surface shell.ts / index.ts depend on. */
export interface LocalProcessHost extends ProcessHost {
  /** True if a terminal's PTY is SIGSTOP-suspended. */
  isSuspended(id: string): boolean
  /** The terminal's shell pid (for the local process monitor). */
  getPid(id: string): number | undefined
  /** Graceful teardown of every local PTY process group (app quit). */
  killAll(): void
  /** Synchronous SIGKILL of every local PTY process group (crash handler). */
  emergencyKill(): void
}

function createBaseLocalProcessHost(): ProcessHost {
  // The existing local shell resolution (with the fallback notice) + the
  // login-shell env, minus npm/Electron vars that would leak into user shells.
  return createProcessCapability({
    resolveShell: (requested) => {
      const r = resolveShell(requested)
      let notice: string | undefined
      if (r.fallback) {
        const reasonText =
          r.reason === 'missing' ? 'not found'
          : r.reason === 'not-executable' ? 'not executable'
          : r.reason === 'disallowed' ? 'not allowed'
          : 'not set'
        const requestedLabel = r.requested ?? '(unset)'
        notice =
          `\x1b[33m[cate] Configured shell '${requestedLabel}' is ${reasonText}; ` +
          `using '${r.path}' instead. Update Settings → General → Default shell path.\x1b[0m\r\n`
      }
      return { path: r.path, args: [], notice }
    },
    getEnv: () =>
      Object.fromEntries(
        Object.entries(getShellEnv()).filter(
          ([key]) => !key.startsWith('npm_') && !key.startsWith('ELECTRON_'),
        ),
      ),
  })
}

function createLocalProcessHost(): LocalProcessHost {
  const base = createBaseLocalProcessHost()
  const pids = new Map<string, number>()
  const idle = new Map<string, IdleState>()
  let scanner: ReturnType<typeof setInterval> | null = null

  const suspend = (id: string): void => {
    if (process.platform === 'win32') return
    if (!getSettingSync('autoSuspendIdleTerminals')) return
    const pid = pids.get(id)
    const state = idle.get(id)
    if (!pid || !state || state.suspended) return
    try { process.kill(-pid, 'SIGSTOP') } catch { /* gone */ }
    state.suspended = true
    log.debug('Suspended idle terminal %s (pid=%d)', id, pid)
  }

  const resume = (id: string): void => {
    const pid = pids.get(id)
    const state = idle.get(id)
    if (!pid || !state || !state.suspended) return
    try { process.kill(-pid, 'SIGCONT') } catch { /* gone */ }
    state.suspended = false
    state.lastOutputAt = Date.now()
    log.debug('Resumed terminal %s (pid=%d)', id, pid)
  }

  const scan = (): void => {
    if (process.platform === 'win32') return
    if (!getSettingSync('autoSuspendIdleTerminals')) {
      for (const [id, state] of idle) if (state.suspended) resume(id)
      return
    }
    const now = Date.now()
    for (const [id, state] of idle) {
      if (state.visible || state.suspended) continue
      if (now - state.lastOutputAt < IDLE_SUSPEND_MS) continue
      suspend(id)
    }
  }

  const ensureScanner = (): void => {
    if (scanner || process.platform === 'win32') return
    scanner = setInterval(scan, IDLE_CHECK_INTERVAL_MS)
  }

  const forget = (id: string): void => {
    pids.delete(id)
    idle.delete(id)
  }

  return {
    create: async (opts, onData, onExit) => {
      const handle = await base.create(
        opts,
        (id, data) => {
          const state = idle.get(id)
          if (state) state.lastOutputAt = Date.now()
          onData(id, data)
        },
        (id, code) => { forget(id); onExit(id, code) },
      )
      pids.set(handle.id, handle.pid)
      idle.set(handle.id, { lastOutputAt: Date.now(), visible: true, suspended: false })
      ensureScanner()
      return handle
    },
    write: (id, data) => {
      if (idle.get(id)?.suspended) resume(id)
      base.write(id, data)
    },
    resize: (id, cols, rows) => {
      if (idle.get(id)?.suspended) resume(id)
      base.resize(id, cols, rows)
    },
    kill: (id) => {
      if (idle.get(id)?.suspended) resume(id)
      // Kill the whole process group so children (dev servers) don't linger.
      const pid = pids.get(id)
      if (pid) { try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ } }
      base.kill(id)
      forget(id)
    },
    getCwd: (id) => base.getCwd(id),
    scanActivity: (ids) => base.scanActivity(ids),
    scanPorts: (ids) => base.scanPorts(ids),
    setVisibility: (id, visible) => {
      base.setVisibility(id, visible)
      const state = idle.get(id)
      if (!state) return
      state.visible = visible
      if (visible && state.suspended) resume(id)
    },

    isSuspended: (id) => idle.get(id)?.suspended === true,
    getPid: (id) => pids.get(id),
    killAll: () => {
      if (scanner) { clearInterval(scanner); scanner = null }
      const all = [...pids.values()].filter(Boolean)
      for (const pid of all) { try { process.kill(-pid, 'SIGCONT') } catch { /* gone */ } }
      for (const pid of all) { try { process.kill(-pid, 'SIGTERM') } catch { /* gone */ } }
      setTimeout(() => {
        for (const pid of all) { try { process.kill(-pid, 'SIGKILL') } catch { /* gone */ } }
      }, 150)
      pids.clear()
      idle.clear()
    },
    emergencyKill: () => {
      for (const pid of pids.values()) {
        if (pid) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
      }
    },
  }
}

/** Process-wide singleton — the local machine's ProcessHost. */
export const localProcessHost = createLocalProcessHost()
