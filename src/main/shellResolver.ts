// =============================================================================
// Shell path resolver — validates a candidate shell path is executable and
// falls back to a platform-appropriate alternative when it isn't.
//
// Fixes a class of failures where a stored `defaultShellPath` (e.g. `/bin/zsh`
// on a Linux system without zsh installed, or an empty value on Windows where
// the resolver previously had no fallback chain at all) makes every terminal
// spawn die immediately with `execvp(3) failed.: No such file or directory`
// — or, on Windows, with `No usable shell found on this system`.
// =============================================================================

import fs from 'fs'
import path from 'path'

const ALLOWED_SHELL_BASENAMES_POSIX = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'])
const ALLOWED_SHELL_BASENAMES_WIN = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'bash.exe',
  'wsl.exe',
])

function isWindows(): boolean {
  return process.platform === 'win32'
}

function isAllowedBasename(candidate: string): boolean {
  if (!candidate) return false
  // Use the explicit platform variant so tests that stub process.platform on a
  // POSIX host still parse Windows paths correctly (default `path.basename`
  // follows the host OS, not the value we're branching on).
  if (isWindows()) {
    return ALLOWED_SHELL_BASENAMES_WIN.has(path.win32.basename(candidate).toLowerCase())
  }
  return ALLOWED_SHELL_BASENAMES_POSIX.has(path.posix.basename(candidate))
}

/** Build the Windows fallback chain from environment + canonical install paths. */
function windowsFallbacks(): string[] {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const fallbacks: string[] = []
  // Honour the user's COMSPEC ahead of hardcoded paths when set.
  if (process.env.COMSPEC) fallbacks.push(process.env.COMSPEC)
  // PowerShell 7+ default install location (modern shell, opt-in install).
  fallbacks.push(path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'))
  // Windows PowerShell 5.1 — ships with every supported Windows version.
  fallbacks.push(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  // cmd.exe — bedrock, always present.
  fallbacks.push(path.win32.join(systemRoot, 'System32', 'cmd.exe'))
  return fallbacks
}

/** Fallback chain by platform, in priority order. */
const POSIX_FALLBACKS: Partial<Record<NodeJS.Platform, string[]>> & { default: string[] } = {
  darwin: ['/bin/zsh', '/bin/bash', '/bin/sh'],
  linux: ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh', '/bin/dash'],
  default: ['/bin/sh'],
}

function getPlatformChain(): string[] {
  if (isWindows()) return windowsFallbacks()
  return POSIX_FALLBACKS[process.platform] ?? POSIX_FALLBACKS.default
}

// $SHELL is irrelevant on Windows — when set (by Git Bash / MSYS / WSL) it
// points at POSIX paths like /usr/bin/bash that node-pty can't spawn natively.
// Use $COMSPEC there instead.
function getEnvShell(): string | undefined {
  if (isWindows()) return process.env.COMSPEC
  return process.env.SHELL
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
  if (!isAllowedBasename(candidate)) return 'disallowed'
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
 *   2. The platform's "env shell" ($SHELL on POSIX, $COMSPEC on Windows)
 *   3. Platform fallback chain
 *
 * Each candidate is rejected if its basename is not in the allowlist or if
 * the file does not exist / is not executable. Throws only if every option
 * fails.
 */
export function resolveShell(preferred?: string): ResolvedShell {
  const platformChain = getPlatformChain()
  const envShell = getEnvShell()

  // 1. Caller-supplied (settings / IPC option)
  if (preferred && preferred.trim()) {
    const trimmed = preferred.trim()
    if (isAllowedBasename(trimmed) && isExecutable(trimmed)) {
      return { path: trimmed, fallback: false }
    }
    const reason = rejectionReason(trimmed)
    const fb = pickFallback([envShell, ...platformChain])
    if (fb) return { path: fb, fallback: true, requested: trimmed, reason }
  }

  // 2. Env shell ($SHELL or $COMSPEC)
  if (envShell && isExecutable(envShell) && isAllowedBasename(envShell)) {
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
    if (!isAllowedBasename(c)) continue
    if (isExecutable(c)) return c
  }
  return null
}
