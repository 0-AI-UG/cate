import fs from 'fs'
import path from 'path'

const POSIX_NAMES = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ksh'])
const WINDOWS_NAMES = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'wsl.exe'])

function isWindows(): boolean {
  return process.platform === 'win32'
}

function isAllowedBasename(candidate: string): boolean {
  if (!candidate) return false
  return isWindows()
    ? WINDOWS_NAMES.has(path.win32.basename(candidate).toLowerCase())
    : POSIX_NAMES.has(path.posix.basename(candidate))
}

function windowsFallbacks(): string[] {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  return [
    process.env.COMSPEC,
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.win32.join(systemRoot, 'System32', 'cmd.exe'),
  ].filter((candidate): candidate is string => Boolean(candidate))
}

const POSIX_FALLBACKS: Partial<Record<NodeJS.Platform, string[]>> & { default: string[] } = {
  darwin: ['/bin/zsh', '/bin/bash', '/bin/sh'],
  linux: ['/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh', '/bin/dash'],
  default: ['/bin/sh'],
}

function platformFallbacks(): string[] {
  if (isWindows()) return windowsFallbacks()
  return POSIX_FALLBACKS[process.platform] ?? POSIX_FALLBACKS.default
}

function environmentShell(): string | undefined {
  return isWindows() ? process.env.COMSPEC : process.env.SHELL
}

export interface ResolvedShell {
  path: string
  fallback: boolean
  requested?: string
  reason?: 'missing' | 'not-executable' | 'disallowed' | 'unset'
}

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

function pickFallback(candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && isAllowedBasename(candidate) && isExecutable(candidate)) return candidate
  }
  return null
}

/** Resolve and validate a shell on the host where the process will run. */
export function resolveShell(preferred?: string): ResolvedShell {
  const fallbacks = platformFallbacks()
  const envShell = environmentShell()
  const requested = preferred?.trim()

  if (requested) {
    if (isAllowedBasename(requested) && isExecutable(requested)) {
      return { path: requested, fallback: false }
    }
    const fallback = pickFallback([envShell, ...fallbacks])
    if (fallback) return { path: fallback, fallback: true, requested, reason: rejectionReason(requested) }
  }

  if (envShell && isAllowedBasename(envShell) && isExecutable(envShell)) {
    return { path: envShell, fallback: false }
  }

  const fallback = pickFallback(fallbacks)
  if (fallback) {
    return {
      path: fallback,
      fallback: Boolean(preferred),
      requested: requested || undefined,
      reason: preferred ? rejectionReason(preferred) : 'unset',
    }
  }
  throw new Error('No usable shell found on this system')
}
