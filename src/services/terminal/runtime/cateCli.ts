// A terminal's CLI entry lives with the workspace, not a versioned install.
// Agent shell snapshots retain PATH and credentials across restores. Refreshing
// this panel's launcher at spawn makes those snapshots use the live runtime
// and its per-PTY token without changing any agent-owned files.

import { rmSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '@kernel/state/node'
import type { EnvContributor } from './extensions'

/** Prepends `dir` to the env's PATH, whatever its case (Windows uses `Path`). */
export function prependPath(env: Readonly<Record<string, string>>, dir: string): Record<string, string> {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return { [key]: env[key] ? dir + path.delimiter + env[key] : dir }
}

export interface CateCliRuntimeDeps {
  /** Private workspace data directory for the stable launchers. */
  launcherDir: string
  nodePath: string
  cliPath: string
  socketPath: string
  mintToken: (panelId: string, terminalId: string) => string
  revokeToken: (token: string) => void
}

export interface CateCliRuntime {
  envForTerminal: EnvContributor
  forgetTerminal(terminalId: string): void
  dispose(): void
}

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
const cmdQuote = (value: string): string => value.replaceAll('%', '%%')

function launcher(deps: CateCliRuntimeDeps, token: string, windows: boolean): string {
  if (windows) {
    return '@echo off\r\nsetlocal DisableDelayedExpansion\r\n' +
      `set "CATE_SOCKET=${cmdQuote(deps.socketPath)}"\r\n` +
      `set "CATE_TOKEN=${cmdQuote(token)}"\r\n` +
      `"${cmdQuote(deps.nodePath)}" "${cmdQuote(deps.cliPath)}" %*\r\n`
  }
  // Git Bash uses the POSIX entry on Windows too.
  const executablePath = (value: string) => shQuote(process.platform === 'win32' ? value.replaceAll('\\', '/') : value)
  return '#!/bin/sh\n' +
    `export CATE_SOCKET=${shQuote(deps.socketPath)}\n` +
    `export CATE_TOKEN=${shQuote(token)}\n` +
    `exec ${executablePath(deps.nodePath)} ${executablePath(deps.cliPath)} "$@"\n`
}

export function createCateCliRuntime(deps: CateCliRuntimeDeps): CateCliRuntime {
  const terminals = new Map<string, { binDir: string; token: string }>()
  const owners = new Map<string, string>()

  const forgetTerminal = (terminalId: string): void => {
    const entry = terminals.get(terminalId)
    if (!entry) return
    terminals.delete(terminalId)
    if (entry.token) deps.revokeToken(entry.token)
    // A replacement PTY of the same panel may already own the launcher.
    if (owners.get(entry.binDir) !== terminalId) return
    owners.delete(entry.binDir)
    try { rmSync(entry.binDir, { recursive: true, force: true }) } catch { /* An open Windows launcher may linger; its token is already revoked. */ }
  }

  return {
    async envForTerminal(spawn) {
      const key = spawn.panelId ?? spawn.terminalId
      if (!/^[A-Za-z0-9._-]+$/.test(key) || key === '.' || key === '..') throw new Error('invalid terminal CLI identity')
      const binDir = path.join(deps.launcherDir, spawn.panelId ? 'panels' : 'processes', key)
      const token = spawn.panelId ? deps.mintToken(spawn.panelId, spawn.terminalId) : ''
      try {
        await writeFileAtomic(path.join(binDir, 'cate'), launcher(deps, token, false), { mode: 0o700 })
        if (process.platform === 'win32') {
          await writeFileAtomic(path.join(binDir, 'cate.cmd'), launcher(deps, token, true), { mode: 0o600 })
        }
      } catch (error) {
        if (token) deps.revokeToken(token)
        throw error
      }
      terminals.set(spawn.terminalId, { binDir, token })
      owners.set(binDir, spawn.terminalId)
      return { ...prependPath(spawn.env, binDir), CATE_SOCKET: deps.socketPath, CATE_TOKEN: token }
    },
    forgetTerminal,
    dispose() {
      for (const terminalId of terminals.keys()) forgetTerminal(terminalId)
    },
  }
}
