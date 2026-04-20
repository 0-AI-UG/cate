// =============================================================================
// Shell path resolver — validates a candidate shell path is executable and
// falls back to a platform-appropriate alternative when it isn't.
//
// Fixes a class of failures where a stored `defaultShellPath` (e.g. `/bin/zsh`
// on a Linux system without zsh installed) makes every terminal spawn die
// immediately with `execvp(3) failed.: No such file or directory`.
// =============================================================================

import fs from 'fs'
import path from 'path'

const ALLOWED_SHELL_BASENAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'])

/** Fallback chain by platform, in priority order. */
const PLATFORM_FALLBACKS: Partial<Record<NodeJS.Platform, string[]>> & { default: string[] } = {
  darwin: ['/bin/zsh', '/bin/bash', '/bin/sh'],
  linux: ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh', '/bin/dash'],
  win32: [], // PTY shell handling on Windows is not validated by this resolver
  default: ['/bin/sh'],
}

export interface ResolvedShell {
  /** The shell path that should actually be spawned. */
  path: string
  /** True when the requested path was rejected and a fallback chosen. */
  fallback: boolean
  /** The originally requested path, when different from `path`. */
  requested?: string
  /** Reason the requested path was rejected (for logs / UI). */
  reason?: 'missing' | 'not-executable' | 'disallowed' | 'unset'
}

/** True when a path exists and the current process can execute it. */
export function isExecutable(candidate: string): boolean {
  if (!candidate) return false
  try {
    const stat = fs.statSync(candidate)
    if (!stat.isFile()) return false
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function rejectionReason(candidate: string): ResolvedShell['reason'] {
  if (!candidate) return 'unset'
  const base = path.basename(candidate)
  if (!ALLOWED_SHELL_BASENAMES.has(base)) return 'disallowed'
  try {
    fs.statSync(candidate)
  } catch {
    return 'missing'
  }
  return 'not-executable'
}

/**
 * Resolve a usable shell path. Tries, in order:
 *   1. `preferred` (from settings / IPC options)
 *   2. `process.env.SHELL`
 *   3. Platform fallback chain
 *
 * Each candidate is rejected if its basename is not in the allowlist or if
 * the file does not exist / is not executable. Throws only if every option
 * fails — extremely unlikely, since `/bin/sh` is part of POSIX.
 */
export function resolveShell(preferred?: string): ResolvedShell {
  const platformChain = PLATFORM_FALLBACKS[process.platform] ?? PLATFORM_FALLBACKS.default

  // 1. Caller-supplied (settings / IPC option)
  if (preferred && preferred.trim()) {
    const trimmed = preferred.trim()
    const base = path.basename(trimmed)
    if (ALLOWED_SHELL_BASENAMES.has(base) && isExecutable(trimmed)) {
      return { path: trimmed, fallback: false }
    }
    const reason = rejectionReason(trimmed)
    const fb = pickFallback([process.env.SHELL, ...platformChain])
    if (fb) return { path: fb, fallback: true, requested: trimmed, reason }
  }

  // 2. process.env.SHELL
  const envShell = process.env.SHELL
  if (envShell && isExecutable(envShell) && ALLOWED_SHELL_BASENAMES.has(path.basename(envShell))) {
    return { path: envShell, fallback: false }
  }

  // 3. Platform fallback chain
  const fb = pickFallback(platformChain)
  if (fb) return { path: fb, fallback: !!preferred, requested: preferred?.trim() || undefined, reason: preferred ? rejectionReason(preferred) : 'unset' }

  throw new Error('No usable shell found on this system')
}

function pickFallback(candidates: Array<string | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue
    if (!ALLOWED_SHELL_BASENAMES.has(path.basename(c))) continue
    if (isExecutable(c)) return c
  }
  return null
}
