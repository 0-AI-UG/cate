// =============================================================================
// loginEnv — give the daemon the user's LOGIN-SHELL environment on every host.
//
// The LOCAL daemon is spawned by Electron with getShellEnv() (the login env
// captured in src/main/shellEnv.ts), but a remote daemon is launched over a
// non-interactive SSH exec channel / `wsl.exe -e`, which inherits only the bare
// system env. That env seeds every non-terminal child the daemon spawns (the
// pi agent, extension servers, git/gh), so tools on ~/.local/bin, nvm, pyenv
// were visible locally and missing remotely for the same setup.
//
// Fix: the daemon captures its own login env at startup (`$SHELL -ilc env -0`,
// mirroring shellEnv.ts) and merges it over process.env, which every capability
// reads live. Hosts whose launcher ALREADY resolved the login env (the local
// transport) set CATE_LOGIN_ENV_RESOLVED=1 to skip the capture — the marker is
// consumed (deleted) either way so children never inherit it. Windows has no
// login-shell concept; skipped there, matching shellEnv.ts.
// =============================================================================

import { spawn } from 'child_process'
import { resolveShell } from './capabilities/shellResolver'

/** Set by launchers that already resolved the login env (localTransport). */
export const LOGIN_ENV_MARKER = 'CATE_LOGIN_ENV_RESOLVED'

/** Cap on the capture shell; a pathological rc file must not stall daemon
 *  startup (the client's connect handshake is waiting on the hello frame). */
const CAPTURE_TIMEOUT_MS = 8_000

/** Parse NUL-delimited `env -0` output (mirrors shellEnv.ts parseEnv). */
function parseEnvZ(raw: string): Record<string, string> | null {
  if (!raw) return null
  const env: Record<string, string> = {}
  for (const entry of raw.split('\0')) {
    const idx = entry.indexOf('=')
    if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1)
  }
  return env
}

function captureLoginEnv(shell: string): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: Record<string, string> | null): void => {
      if (!done) {
        done = true
        resolve(v)
      }
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(shell, ['-ilc', 'env -0'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return finish(null)
    }
    let out = ''
    child.stdout?.on('data', (c: Buffer) => { out += c.toString() })
    child.on('close', () => finish(parseEnvZ(out)))
    child.on('error', () => finish(null))
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already exited */ }
      finish(null)
    }, CAPTURE_TIMEOUT_MS)
    timer.unref()
  })
}

/** Resolve the login-shell env and merge it over process.env. Best effort —
 *  a failed/timed-out capture leaves the env untouched. Call once at daemon
 *  startup, BEFORE serving requests, so the first spawn already sees it. */
export async function applyLoginEnv(): Promise<void> {
  const alreadyResolved = process.env[LOGIN_ENV_MARKER] === '1'
  delete process.env[LOGIN_ENV_MARKER] // never leaks into spawned children
  if (alreadyResolved || process.platform === 'win32') return

  const shell = resolveShell(process.env.SHELL).path
  const captured = await captureLoginEnv(shell)
  // A capture without PATH is a failed capture — don't degrade the env.
  if (!captured?.PATH) return
  for (const [key, value] of Object.entries(captured)) {
    // Same scrub as shellEnv.sanitizeEnv: never propagate Electron/npm
    // lifecycle vars into everything the daemon spawns.
    if (key.startsWith('ELECTRON_') || key.startsWith('npm_')) continue
    process.env[key] = value
  }
}
