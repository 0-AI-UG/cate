// =============================================================================
// Shell Environment Resolver
// Spawns the user's login shell to capture their real environment variables.
// On macOS/Linux, GUI-launched Electron apps inherit a minimal PATH that
// misses Homebrew, nvm, pyenv, etc. This module resolves the full shell env
// once at startup and caches it for the lifetime of the process.
// Approach matches VS Code (src/vs/platform/shell/node/shellEnv.ts).
// =============================================================================

import { spawn } from 'child_process'
import log from './logger'

let resolvedEnv: Record<string, string> | null = null
let resolvePromise: Promise<Record<string, string>> | null = null

/**
 * Spawn the user's default login shell and parse its environment.
 * Uses `env -0` (NUL-delimited) to safely handle values with newlines.
 * Times out after 10 seconds, falling back to process.env.
 */
function resolveShellEnv(): Promise<Record<string, string>> {
  const shell = process.env.SHELL || '/bin/zsh'
  log.debug('Resolving shell environment from %s', shell)

  return new Promise((resolve) => {
    const child = spawn(shell, ['-ilc', 'env -0'], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        // Prevent Electron from interfering with the child shell
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    } as any)

    let stdout = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })

    child.on('close', () => {
      const env = parseEnv(stdout)
      if (env && Object.keys(env).length > 0) {
        log.debug('Shell environment resolved (%d vars)', Object.keys(env).length)
        resolve(env)
      } else {
        log.warn('Shell environment resolution returned empty, using process.env')
        resolve({ ...process.env } as Record<string, string>)
      }
    })

    child.on('error', () => {
      log.warn('Shell environment resolution failed, using process.env')
      resolve({ ...process.env } as Record<string, string>)
    })

    // Hard timeout fallback in case 'close' never fires
    setTimeout(() => {
      try { child.kill() } catch { /* already exited */ }
      resolve({ ...process.env } as Record<string, string>)
    }, 10_000)
  })
}

/**
 * Parse NUL-delimited `env -0` output into a Record.
 */
function parseEnv(raw: string): Record<string, string> | null {
  if (!raw) return null
  const env: Record<string, string> = {}
  const entries = raw.split('\0')
  for (const entry of entries) {
    const idx = entry.indexOf('=')
    if (idx > 0) {
      env[entry.slice(0, idx)] = entry.slice(idx + 1)
    }
  }
  return env
}

/**
 * Initialize the shell environment resolver. Call once at app startup.
 * Safe to call multiple times — only the first call spawns a shell.
 */
export function initShellEnv(): Promise<Record<string, string>> {
  if (!resolvePromise) {
    // Only resolve on macOS/Linux; Windows doesn't have this problem
    if (process.platform === 'win32') {
      resolvedEnv = { ...process.env } as Record<string, string>
      resolvePromise = Promise.resolve(resolvedEnv)
    } else {
      resolvePromise = resolveShellEnv().then((env) => {
        resolvedEnv = env
        return env
      })
    }
  }
  return resolvePromise
}

/**
 * Get the resolved shell environment. Returns process.env if not yet resolved.
 */
export function getShellEnv(): Record<string, string> {
  return resolvedEnv ?? ({ ...process.env } as Record<string, string>)
}
