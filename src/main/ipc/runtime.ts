// =============================================================================
// Runtime connection IPC — lets the renderer connect to / disconnect from a
// remote (SSH) or WSL runtime. Connecting mints a stable runtimeId, persists
// any SSH passphrase via safeStorage, builds the matching transport, and hands
// it to the RuntimeManager (bootstrap → launch → handshake → register). On
// success it returns the locator rootPath + connection record the renderer uses
// to create the workspace.
// =============================================================================

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import log from '../logger'
import {
  RUNTIME_CONNECT,
  RUNTIME_ENSURE,
  RUNTIME_DELETE,
  RUNTIME_INSTALL,
  RUNTIME_LIST,
  RUNTIME_WSL_DISTROS,
  RUNTIME_SSH_HOSTS,
  RUNTIME_STATUS,
  RUNTIME_LOCAL_STATUS,
  RUNTIME_RETRY_LOCAL,
  RUNTIME_PICK_SSH_KEY,
} from '../../shared/ipc-channels'
import { runtimes, RuntimeManager } from '../runtime/runtimeManager'
import type {
  RemoteConnectSpec,
  RuntimeConnectResult,
  RuntimeConnection,
  RuntimeStatusEvent,
  SshHostEntry,
} from '../../shared/types'
import { broadcastToAll } from '../windowRegistry'
import { assertAbsoluteRuntimePath, formatLocator } from '../../shared/runtimeLocator'
import {
  isRemoteRuntimeConnection,
  remoteConnectSpecFromConnection,
  runtimeConnectionFromSpec,
  runtimeConnectionPath,
} from '../../shared/runtimeConnection'
// settingsFile, not ../store: getSettingSync is a re-export of this getSetting,
// and store.ts's side-effect graph (analytics, menu, auto-updater) would bloat
// every bundle of the buildTransport graph (see buildTransport.interop.test.ts).
import { getSetting } from '../settingsFile'
import type { RuntimeTransport } from '../runtime/transports/transport'
import { SshTransport } from '../runtime/transports/sshTransport'
import { WslTransport } from '../runtime/transports/wslTransport'
import { saveSshSecret, getSshSecret, type SshSecret } from '../runtime/sshSecretStore'
import { normalizeKeyPath, assertNotPuttyKey } from '../runtime/sshKey'
import { getShellEnv } from '../shellEnv'

const execFileP = promisify(execFile)

/** Installed WSL distro names (Windows only). `wsl.exe --list --quiet` prints
 *  one name per line in UTF-16LE; returns [] on any non-Windows host or when
 *  WSL isn't available so the renderer can fall back to a free-text input. */
export async function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  try {
    const { stdout } = await execFileP('wsl.exe', ['--list', '--quiet'], { encoding: 'buffer' })
    return stdout
      .toString('utf16le')
      .split(/\r?\n/)
      .map((s) => s.replace(/\x00/g, '').trim())
      .filter(Boolean)
  } catch (err) {
    log.warn('[runtime:wsl-distros] failed to list: %s', err instanceof Error ? err.message : String(err))
    return []
  }
}

/** Pure parse of ~/.ssh/config text into connectable host aliases. Best-effort:
 *  a minimal parser (no Include/Match/token expansion), wildcard patterns are
 *  dropped. Keys are case-insensitive and accept `Key value` or `Key=value`; a
 *  leading `~` in IdentityFile is expanded to `home`. HostName defaults to the
 *  alias when unset. Settings apply to every alias on the preceding `Host` line. */
export function parseSshConfig(text: string, home: string): SshHostEntry[] {
  const entries: SshHostEntry[] = []
  // Aliases from the current `Host` line. Empty when the block is wildcard-only
  // (global defaults we don't surface as connectable targets).
  let current: { alias: string; host?: string; user?: string; port?: number; identityFile?: string }[] = []
  const flush = (): void => {
    for (const c of current) entries.push({ ...c, host: c.host ?? c.alias })
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+?)[\s=]+(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()

    if (key === 'host') {
      flush()
      current = value
        .split(/\s+/)
        .filter((a) => a && !a.includes('*') && !a.includes('?') && !a.startsWith('!'))
        .map((alias) => ({ alias }))
      continue
    }
    if (!current.length) continue
    for (const c of current) {
      if (key === 'hostname') c.host = value
      else if (key === 'user') c.user = value
      else if (key === 'port') {
        const n = Number(value)
        if (Number.isFinite(n)) c.port = n
      } else if (key === 'identityfile') {
        c.identityFile = value.replace(/^~(?=$|\/)/, home)
      }
    }
  }
  flush()
  return entries
}

/** Connectable host aliases from the user's ~/.ssh/config so the connect form
 *  can prefill from what ssh already knows. Read-only; any failure (missing
 *  file, unreadable) yields [] and the form falls back to manual entry. */
export async function listSshHosts(): Promise<SshHostEntry[]> {
  try {
    const text = await readFile(join(homedir(), '.ssh', 'config'), 'utf8')
    return parseSshConfig(text, homedir())
  } catch {
    return []
  }
}

/** Stable, deterministic id so reconnecting the same target reuses its slot.
 *  The path is part of the identity (like the server case): each daemon sandboxes
 *  to a single --root, so two workspaces at different paths in the same distro
 *  need distinct ids, otherwise the second reuses the first daemon and its path
 *  falls outside that daemon's allowed root. The (sanitized) distro name is kept
 *  as a readable prefix; the path hash makes it unique. */
export function mintRuntimeId(spec: RemoteConnectSpec): string {
  if (spec.kind === 'wsl') {
    const safe = spec.distro.replace(/[^a-zA-Z0-9_.-]/g, '-')
    const h = createHash('sha256').update(`${spec.distro}\0${spec.distroPath}`).digest('hex').slice(0, 10)
    return `wsl_${safe}_${h}`
  }
  const h = createHash('sha256')
    .update(`${spec.user}@${spec.host}:${spec.port ?? 22}${spec.remotePath}`)
    .digest('hex')
    .slice(0, 10)
  return `srv_${h}`
}

/** Merge edit-form auth with the stored secret. Blank key/passphrase fields are
 * intentionally "reuse", while the agent checkbox is always authoritative. */
export function mergedSshSecret(current: SshSecret | null, auth: NonNullable<Extract<RemoteConnectSpec, { kind: 'server' }>['auth']>): SshSecret {
  return {
    passphrase: auth.passphrase ?? current?.passphrase,
    keyPath: auth.keyPath ?? current?.keyPath,
    useAgent: auth.useAgent ?? current?.useAgent,
  }
}

/** Build (but do not start) the transport for a connection spec. The runtime
 *  daemon is installed on first connect by the transport itself (remote-pull
 *  from the GitHub release, with a client-side scp/copy fallback — see
 *  runtimeArtifacts.ts), so nothing runtime-related ships with the app. */
export async function buildTransport(runtimeId: string, spec: RemoteConnectSpec): Promise<RuntimeTransport> {
  assertAbsoluteRuntimePath(spec.kind === 'server' ? spec.remotePath : spec.distroPath)
  if (spec.kind === 'wsl') {
    // Guard before we hand off to the transport so the failure is a clear
    // message rather than a raw wsl.exe ENOENT / "no distribution" error.
    if (process.platform !== 'win32') throw new Error('WSL connections are only available on Windows')
    const installed = await listWslDistros()
    if (installed.length === 0) throw new Error('No WSL distros are installed on this machine')
    if (!installed.includes(spec.distro)) {
      throw new Error(`WSL distro "${spec.distro}" not found. Installed: ${installed.join(', ')}`)
    }
    return new WslTransport({
      distro: spec.distro,
      root: spec.distroPath,
      id: runtimeId,
      // Same launch config the local daemon gets (main/index.ts) so a WSL host
      // honors the exclusion + idle-suspend settings identically. Later live
      // changes are forwarded to every connected runtime by the store.
      exclusions: getSetting('fileExclusions'),
      idleSuspend: getSetting('autoSuspendIdleTerminals'),
    })
  }
  // server (SSH): resolve stored secret + optional identity path. The system
  // OpenSSH client reads the key itself so it can also discover an adjacent
  // `-cert.pub` certificate and apply the user's complete SSH configuration.
  const secret = await getSshSecret(runtimeId)
  const passphrase = spec.auth?.passphrase ?? secret?.passphrase
  const rawKeyPath = spec.auth?.keyPath ?? secret?.keyPath
  // Normalize before reading: strips surrounding quotes from a pasted path and
  // expands `~`, so a copy/pasted "C:\…\key.pem" doesn't ENOENT against the app
  // dir (#335). A read failure names the (cleaned) path instead of a raw errno.
  let keyPath: string | undefined
  if (rawKeyPath) {
    keyPath = normalizeKeyPath(rawKeyPath)
    try {
      const header = await readFile(keyPath)
      assertNotPuttyKey(header)
    } catch (err) {
      if (err instanceof Error && /PuTTY \.ppk/.test(err.message)) throw err
      const reason = (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'file not found' : err instanceof Error ? err.message : String(err)
      throw new Error(`Couldn't read the SSH private key at "${keyPath}": ${reason}`)
    }
  }
  return new SshTransport({
    host: spec.host,
    user: spec.user,
    port: spec.port,
    root: spec.remotePath,
    id: runtimeId,
    keyPath,
    passphrase,
    useAgent: spec.auth?.useAgent ?? secret?.useAgent,
    // GUI-launched Electron processes do not reliably inherit SSH_AUTH_SOCK or
    // the user's PATH. Cate resolves the login-shell environment at startup;
    // OpenSSH must receive that same authoritative environment.
    env: getShellEnv(),
    // Same launch config the local daemon gets (main/index.ts) so an SSH host
    // honors the exclusion + idle-suspend settings identically. Later live
    // changes are forwarded to every connected runtime by the store.
    exclusions: getSetting('fileExclusions'),
    idleSuspend: getSetting('autoSuspendIdleTerminals'),
  })
}

export function registerRuntimeHandlers(): void {
  // Forward connection-state changes (incl. async drops) to the renderer.
  runtimes.setStatusListener((runtimeId, phase, message) => {
    const evt: RuntimeStatusEvent = { runtimeId, phase, message }
    broadcastToAll(RUNTIME_STATUS, evt)
  })

  // Registration only — NO network. Mints the stable id, persists SSH auth, and
  // returns the locator + connection record. The renderer stores the connection
  // and then probes (ensure); the actual reachable/installed/connected state is
  // determined there and streamed back as phases. Keeps state purely
  // probe-driven instead of inferred from this call.
  ipcMain.handle(RUNTIME_CONNECT, async (_event, spec: RemoteConnectSpec): Promise<RuntimeConnectResult> => {
    try {
      const remotePath = spec.kind === 'server' ? spec.remotePath : spec.distroPath
      assertAbsoluteRuntimePath(remotePath)
      const runtimeId = mintRuntimeId(spec)
      if (spec.kind === 'server' && spec.auth) {
        // Blank key/passphrase fields in Edit mean "reuse the stored value";
        // useAgent is an explicit boolean and must persist false as well as true.
        const current = await getSshSecret(runtimeId)
        await saveSshSecret(runtimeId, mergedSshSecret(current, spec.auth))
      }
      const connection = runtimeConnectionFromSpec(runtimeId, spec)
      const rootPath = formatLocator({ runtimeId, path: remotePath })
      return { ok: true, runtimeId, rootPath, connection }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[runtime:connect] failed: %s', message)
      return { ok: false, error: message }
    }
  })

  // Probe + connect from a stored connection (restore / reconnect / retry).
  // install=false: if the host is reachable but the daemon isn't installed the
  // probe stops at `missing` (emitted to the renderer); installing is explicit.
  ipcMain.handle(RUNTIME_ENSURE, async (_event, connection: RuntimeConnection): Promise<RuntimeConnectResult> => {
    if (!isRemoteRuntimeConnection(connection)) return { ok: false, error: 'local connection needs no runtime' }
    const { runtimeId } = connection
    const remotePath = runtimeConnectionPath(connection)
    let rootPath: string
    try {
      rootPath = formatLocator({ runtimeId, path: remotePath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtimes.report(runtimeId, 'unreachable', message)
      log.warn('[runtime:ensure] %s rejected: %s', runtimeId, message)
      return { ok: false, error: message }
    }
    // isConnected (not has): connect() now registers a DeferredRuntime
    // synchronously while connecting, so has() would be true mid-connect too. Only
    // short-circuit when FULLY connected; an in-flight connect falls through to
    // connect() below, which dedupes onto the live attempt.
    if (runtimes.isConnected(runtimeId)) {
      runtimes.reportConnected(runtimeId) // re-assert the phase for the renderer
      return { ok: true, runtimeId, rootPath, connection }
    }
    // Build the transport first (reads + validates the SSH key). A failure here
    // is BEFORE any connect, so doConnect never runs and emits no phase — emit
    // `unreachable` ourselves with the real reason (e.g. unsupported key format)
    // so the lock overlay shows it instead of a bare "failed to connect".
    let transport: RuntimeTransport
    try {
      transport = await buildTransport(runtimeId, remoteConnectSpecFromConnection(connection))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtimes.report(runtimeId, 'unreachable', message)
      log.warn('[runtime:ensure] %s setup failed: %s', runtimeId, message)
      return { ok: false, error: message }
    }
    try {
      await runtimes.connect(runtimeId, transport)
      return { ok: true, runtimeId, rootPath, connection }
    } catch (err) {
      // "Not installed" is an expected probe outcome — the phase is already
      // 'missing'; report it quietly (not a host/network failure).
      if (err instanceof RuntimeManager.NotInstalled) {
        return { ok: false, error: 'runtime not installed' }
      }
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[runtime:ensure] %s failed: %s', runtimeId, message)
      return { ok: false, error: message }
    }
  })

  // Explicit install: tear down any live connection (so the daemon stops and the
  // connect() dedupe doesn't short-circuit), then connect with install+force —
  // a clean wipe + re-pull/push of the bundle, then connect. The only path that
  // installs anything; everything else only probes.
  ipcMain.handle(RUNTIME_INSTALL, async (_event, connection: RuntimeConnection): Promise<RuntimeConnectResult> => {
    if (!isRemoteRuntimeConnection(connection)) return { ok: false, error: 'the local runtime has nothing to install' }
    const { runtimeId } = connection
    const remotePath = runtimeConnectionPath(connection)
    let rootPath: string
    try {
      rootPath = formatLocator({ runtimeId, path: remotePath })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtimes.report(runtimeId, 'unreachable', message)
      log.warn('[runtime:install] %s rejected: %s', runtimeId, message)
      return { ok: false, error: message }
    }
    await runtimes.disposeConnection(runtimeId)
    let transport: RuntimeTransport
    try {
      transport = await buildTransport(runtimeId, remoteConnectSpecFromConnection(connection))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      runtimes.report(runtimeId, 'unreachable', message)
      log.warn('[runtime:install] %s setup failed: %s', runtimeId, message)
      return { ok: false, error: message }
    }
    try {
      await runtimes.connect(runtimeId, transport, { install: true, force: true })
      return { ok: true, runtimeId, rootPath, connection }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[runtime:install] %s failed: %s', runtimeId, message)
      return { ok: false, error: message }
    }
  })

  // Literally delete the runtime: stop the daemon and rm -rf its install on
  // the host, keeping the saved auth so a later Install doesn't re-prompt. Drops
  // the workspace to `missing` (emitted by deleteInstall); the user recovers
  // through the normal Install — no special client state-setting.
  ipcMain.handle(RUNTIME_DELETE, async (_event, connection: RuntimeConnection): Promise<{ ok: boolean; error?: string }> => {
    if (!isRemoteRuntimeConnection(connection)) return { ok: false, error: 'the local runtime cannot be deleted' }
    const { runtimeId } = connection
    try {
      const transport = await buildTransport(runtimeId, remoteConnectSpecFromConnection(connection))
      await runtimes.deleteInstall(runtimeId, transport)
      return { ok: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.warn('[runtime:delete] %s failed: %s', runtimeId, message)
      return { ok: false, error: message }
    }
  })

  ipcMain.handle(RUNTIME_LIST, async () => {
    return runtimes.connectedIds()
  })

  // Current phase of the built-in LOCAL runtime. The renderer seeds its startup
  // loading blocker from this, since the local connect can finish (or fail)
  // before a window subscribes to the RUNTIME_STATUS broadcast.
  ipcMain.handle(RUNTIME_LOCAL_STATUS, async () => {
    return runtimes.localStatus()
  })

  // Relaunch the built-in LOCAL daemon after a failed startup connect or crash —
  // the renderer's Retry path (terminal create failure / lock overlay). Without
  // this, a single failed local connect left the workspace dead until app
  // restart: nothing re-ran ensureLocalRuntime and RUNTIME_ENSURE rejects
  // local connections. Resolves once the connect settles; phases stream to the
  // renderer via RUNTIME_STATUS as usual.
  ipcMain.handle(RUNTIME_RETRY_LOCAL, async (): Promise<{ ok: boolean; error?: string }> => {
    const res = await runtimes.retryLocal()
    if (!res.ok) log.warn('[runtime:retry-local] %s', res.error ?? 'failed')
    return res
  })

  ipcMain.handle(RUNTIME_WSL_DISTROS, async () => {
    return listWslDistros()
  })

  ipcMain.handle(RUNTIME_SSH_HOSTS, async () => {
    return listSshHosts()
  })

  // Native file picker for the SSH private key (#334) — typing the path still
  // works; this just removes the typos. Defaults into ~/.ssh and shows dotfiles
  // (key files are hidden there). Returns the chosen path, or null if cancelled.
  ipcMain.handle(RUNTIME_PICK_SSH_KEY, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
    const result = await dialog.showOpenDialog(win!, {
      title: 'Select SSH private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}
