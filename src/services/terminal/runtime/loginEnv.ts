// The daemon's login-shell environment. A daemon started over a bare exec
// channel sees only the system env, so tools on ~/.local/bin, nvm or pyenv
// would be missing from terminals, git and T3. The daemon captures
// `$SHELL -ilc env -0` once at startup and merges it over process.env, which
// every module reads. A launcher that already resolved the login env sets
// CATE_LOGIN_ENV_RESOLVED=1 to skip the capture; the marker never reaches
// children. Windows has no login shell and is skipped.

import { spawn } from 'node:child_process'
import { resolveShell } from './shellResolver'

export const LOGIN_ENV_MARKER = 'CATE_LOGIN_ENV_RESOLVED'

/** A pathological rc file must not stall daemon startup. */
const CAPTURE_TIMEOUT_MS = 8_000

/** Parses NUL-delimited `env -0` output. */
export function parseEnvZ(raw: string): Record<string, string> | null {
  if (!raw) return null
  const env: Record<string, string> = {}
  for (const entry of raw.split('\0')) {
    const idx = entry.indexOf('=')
    if (idx > 0) env[entry.slice(0, idx)] = entry.slice(idx + 1)
  }
  return env
}

/** Electron and npm lifecycle variables must never reach spawned programs:
 *  ELECTRON_RUN_AS_NODE makes an Electron app launched in a terminal boot as
 *  plain Node, npm_* pollutes every shell of a dev build. */
function isForeignEnvKey(key: string): boolean {
  return key.startsWith('ELECTRON_') || key.startsWith('npm_')
}

export function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !isForeignEnvKey(key)) clean[key] = value
  }
  return clean
}

export function captureLoginEnv(shell: string): Promise<Record<string, string> | null> {
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

/** Merges the login-shell env over process.env. Best effort: a failed
 *  capture leaves the env as it is. Call once before serving requests. */
export async function applyLoginEnv(): Promise<void> {
  const alreadyResolved = process.env[LOGIN_ENV_MARKER] === '1'
  delete process.env[LOGIN_ENV_MARKER]
  if (alreadyResolved || process.platform === 'win32') return
  const captured = await captureLoginEnv(resolveShell(process.env.SHELL).path)
  // A capture without PATH failed; keep the env we have.
  if (!captured?.PATH) return
  for (const [key, value] of Object.entries(captured)) {
    if (!isForeignEnvKey(key)) process.env[key] = value
  }
}
