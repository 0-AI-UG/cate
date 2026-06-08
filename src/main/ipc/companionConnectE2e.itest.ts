// =============================================================================
// END-TO-END companion harness — drives the REAL ipc handlers through EVERY layer
// the renderer touches, against a real remote (SSH server) and/or a real WSL
// distro:
//
//   COMPANION_CONNECT  → persist auth (real sshSecretStore, encrypted) + mint id
//   COMPANION_INSTALL  → buildTransport → CompanionManager.connect → Ssh/WslTransport
//                        → probe → bootstrap/install → launch → handshake → register
//   COMPANION_ENSURE   → restore from the stored connection and reconnect; hold to
//                        prove it doesn't self-drop (#335)
//   COMPANION_DELETE   → uninstall (+ unpin host key for SSH)
//
// Unlike sshLive.itest.ts (which constructs SshTransport directly with a hand-read
// key and a stubbed host-key check — so it never exercises buildTransport, key
// reading, path normalization, format validation, the secret store, or the WSL
// branch at all), this harness goes through buildTransport for every auth
// parameter and BOTH transports.
//
// Opt-in only, gated per transport so each block runs where it can:
//   SSH:  CATE_LIVE_SSH=1   (any host with a reachable server + key)
//   WSL:  CATE_LIVE_WSL=1   (a Windows host with the named distro installed)
// A *.itest.ts name keeps the normal vitest `include` from picking it up. NOT CI.
//
// Run (SSH):  CATE_LIVE_SSH=1 CATE_LIVE_SSH_HOST=1.2.3.4 CATE_LIVE_SSH_USER=leigh \
//             CATE_LIVE_SSH_ROOT=/home/leigh CATE_LIVE_SSH_KEY=~/.ssh/id_ed25519 \
//             npx vitest run --config vitest.live.config.ts \
//             src/main/ipc/companionConnectE2e.itest.ts
//
// Run (WSL, on Windows):  set CATE_LIVE_WSL=1 & set CATE_LIVE_WSL_DISTRO=Ubuntu-24.04 ^
//             & set CATE_LIVE_WSL_PATH=/home/leigh ^
//             & npx vitest run --config vitest.live.config.ts src/main/ipc/companionConnectE2e.itest.ts
//
// Optional SSH extras (each test self-skips when its env is absent):
//   passphrase: CATE_LIVE_SSH_KEY_ENC=<encrypted key> CATE_LIVE_SSH_PASSPHRASE=...
//   ssh-agent:  CATE_LIVE_SSH_USE_AGENT=1   (needs a running agent / SSH_AUTH_SOCK)
//
// Run it in the NATURAL dev mode (don't set CATE_COMPANION_DEV=0). isPackaged is
// mocked false, so the harness installs from the local dist-companion tarball via
// bootstrapDev — self-consistent. Forcing CATE_COMPANION_DEV=0 takes the
// production remote-pull path, which writes a bare-version `.ok` while isInstalled
// (seeing the same local tarball) expects a version:hash marker — so the next
// install=false probe reports "not installed". That mismatch is specific to
// "production pull + a local tarball present" and never occurs in a packaged app
// (no local tarball) or real dev mode (bootstrapDev).
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'

// ── Electron + windowRegistry stubs (hoisted so the vi.mock factories can see
// them). The status broadcaster is rerouted into `captured` so we can assert the
// exact phase stream the renderer would receive. ───────────────────────────────
const H = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, arg: unknown) => unknown>(),
  captured: [] as { companionId: string; phase: string; message?: string }[],
  state: { userDataDir: '' },
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getName: () => 'Cate',
    // userData → a throwaway dir so the real secret / known-hosts stores round-trip
    // on disk without touching the developer's actual Cate state.
    getPath: (name: string) => (name === 'userData' ? H.state.userDataDir : join(H.state.userDataDir, name)),
  },
  // Reversible stand-in for the OS keychain — exercises sshSecretStore's encrypt
  // branch + base64 round-trip without a real Electron runtime.
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''),
  },
  ipcMain: { handle: (channel: string, fn: (event: unknown, arg: unknown) => unknown) => H.handlers.set(channel, fn) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }) },
  BrowserWindow: { fromWebContents: () => undefined, getAllWindows: () => [] },
}))

vi.mock('../windowRegistry', () => ({
  broadcastToAll: (_channel: string, payload: { companionId: string; phase: string; message?: string }) => {
    H.captured.push(payload)
  },
}))

import {
  COMPANION_CONNECT,
  COMPANION_ENSURE,
  COMPANION_INSTALL,
  COMPANION_DELETE,
} from '../../shared/ipc-channels'
import type { RemoteConnectSpec, CompanionConnection, CompanionConnectResult } from '../../shared/types'

// ── Shared harness wiring (both transport blocks drive the same handlers). ──────
let companions: typeof import('../companion/companionManager').companions

const invoke = <T = CompanionConnectResult>(channel: string, arg: unknown): Promise<T> => {
  const fn = H.handlers.get(channel)
  if (!fn) throw new Error(`no handler registered for ${channel}`)
  return Promise.resolve(fn({ sender: {} }, arg)) as Promise<T>
}
/** Phases captured since a mark, for asserting the renderer-visible stream. */
const phasesSince = (mark: number): string[] => H.captured.slice(mark).map((e) => e.phase)
const readJson = (file: string): Record<string, unknown> => {
  const p = join(H.state.userDataDir, file)
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {}
}

beforeAll(async () => {
  H.state.userDataDir = mkdtempSync(join(tmpdir(), 'cate-e2e-'))
  ;(await import('./companion')).registerCompanionHandlers()
  companions = (await import('../companion/companionManager')).companions
})
afterAll(async () => {
  try { await companions?.disposeAll() } catch { /* ignore */ }
  if (H.state.userDataDir) rmSync(H.state.userDataDir, { recursive: true, force: true })
})

// =============================================================================
// SSH server
// =============================================================================
const LIVE_SSH = process.env.CATE_LIVE_SSH === '1' && !!process.env.CATE_LIVE_SSH_HOST

const HOST = process.env.CATE_LIVE_SSH_HOST ?? ''
const USER = process.env.CATE_LIVE_SSH_USER ?? 'root'
const PORT = Number(process.env.CATE_LIVE_SSH_PORT ?? '22')
const ROOT = process.env.CATE_LIVE_SSH_ROOT ?? '/root/'
const expandTilde = (p: string): string => p.replace(/^~(?=$|\/)/, homedir())
const KEY = expandTilde(process.env.CATE_LIVE_SSH_KEY ?? join(homedir(), '.ssh', 'id_ed25519'))

const ENC_KEY = process.env.CATE_LIVE_SSH_KEY_ENC ? expandTilde(process.env.CATE_LIVE_SSH_KEY_ENC) : ''
const PASSPHRASE = process.env.CATE_LIVE_SSH_PASSPHRASE ?? ''
const USE_AGENT = process.env.CATE_LIVE_SSH_USE_AGENT === '1' && !!process.env.SSH_AUTH_SOCK

/** Live companion daemons on the SSH server (one per live transport; >1 = leak). */
function serverDaemonCount(): number {
  try {
    const out = execFileSync(
      'ssh',
      ['-i', KEY, '-p', String(PORT), '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', `${USER}@${HOST}`,
       "pgrep -f 'companion[.]cjs' | wc -l"],
      { encoding: 'utf8' },
    )
    return parseInt(out.trim(), 10) || 0
  } catch {
    return -1 // ssh probe itself failed — don't fail the test on the out-of-band check
  }
}

describe.skipIf(!LIVE_SSH)('SSH companion connect — full e2e through the IPC handlers', () => {
  // Established by the CONNECT test, reused by the rest (one stored record / workspace).
  let connection: Extract<CompanionConnection, { kind: 'server' }>

  const serverSpec = (auth: { keyPath?: string; passphrase?: string; useAgent?: boolean }): RemoteConnectSpec => ({
    kind: 'server', host: HOST, user: USER, port: PORT, remotePath: ROOT, auth,
  })
  /** Re-persist the GOOD key as the stored secret (recover after negative tests
   *  that deliberately store a broken keyPath). */
  const saveGoodSecret = () => invoke(COMPANION_CONNECT, serverSpec({ keyPath: KEY }))

  test('CONNECT persists the SSH auth (encrypted) and mints a stable connection', async () => {
    const res = await invoke(COMPANION_CONNECT, serverSpec({ keyPath: KEY }))
    expect(res.ok, JSON.stringify(res)).toBe(true)
    if (!res.ok) return
    expect(res.companionId).toMatch(/^srv_/)
    expect(res.connection.kind).toBe('server')
    connection = res.connection as Extract<CompanionConnection, { kind: 'server' }>

    // The real sshSecretStore wrote the key path (plaintext) under our temp userData.
    const secrets = readJson('companion-ssh-secrets.json')
    expect(secrets[res.companionId]).toMatchObject({ keyPath: KEY })
  })

  test('INSTALL brings the daemon up end-to-end and pins the host key (TOFU)', async () => {
    const mark = H.captured.length
    const res = await invoke(COMPANION_INSTALL, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    expect(phasesSince(mark)).toContain('connected')
    // Exactly one live daemon — extras would mean a leaked/duplicate transport.
    const daemons = serverDaemonCount()
    expect(daemons === -1 || daemons <= 1, `daemon count=${daemons}`).toBe(true)
    // The REAL verifyAndPinHostKey ran (sshLive.itest.ts stubs it) and pinned.
    const known = readJson('companion-known-hosts.json')
    expect(Object.keys(known)).toContain(`${HOST}:${PORT}`)
  }, 180_000)

  test('ENSURE restores from the stored connection and HOLDS without self-dropping (#335)', async () => {
    await companions.disposeConnection(connection.companionId)
    const mark = H.captured.length
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    const afterConnect = H.captured.length
    await new Promise((r) => setTimeout(r, 6000))
    const duringHold = phasesSince(afterConnect)
    expect(companions.isConnected(connection.companionId), `dropped during hold: ${JSON.stringify(duringHold)}`).toBe(true)
    expect(duringHold, 'no phase changes expected during a quiet hold').toEqual([])
    expect(phasesSince(mark)).toContain('connected')
  }, 60_000)

  test('quoted + ~ key paths still resolve (normalizeKeyPath in the live path)', async () => {
    await companions.disposeConnection(connection.companionId)
    // A pasted, quoted path — the exact #335 sub-bug that ENOENT'd against the app dir.
    await invoke(COMPANION_CONNECT, serverSpec({ keyPath: `"${KEY}"` }))
    let res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok, `quoted path failed: ${JSON.stringify(res)}`).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)

    // A ~-relative path, when the key lives under $HOME.
    if (KEY.startsWith(homedir())) {
      await companions.disposeConnection(connection.companionId)
      const tildePath = '~' + KEY.slice(homedir().length)
      await invoke(COMPANION_CONNECT, serverSpec({ keyPath: tildePath }))
      res = await invoke(COMPANION_ENSURE, connection)
      expect(res.ok, `~ path failed: ${JSON.stringify(res)}`).toBe(true)
    }
    await saveGoodSecret()
  }, 60_000)

  test('unsupported key format (PuTTY .ppk) is rejected up front with guidance', async () => {
    const ppk = join(H.state.userDataDir, 'fake.ppk')
    writeFileSync(ppk, 'PuTTY-User-Key-File-2: ssh-rsa\nEncryption: none\n')
    await companions.disposeConnection(connection.companionId)
    await invoke(COMPANION_CONNECT, serverSpec({ keyPath: ppk }))
    const mark = H.captured.length
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/PuTTY .ppk/)
    // The handler maps a pre-connect build failure to an 'unreachable' phase so the
    // lock overlay shows the real reason instead of a bare "failed to connect".
    expect(phasesSince(mark)).toContain('unreachable')
    await saveGoodSecret()
  })

  test('a missing key file fails with a clear, path-named error (not a raw errno)', async () => {
    const missing = join(H.state.userDataDir, 'does-not-exist.pem')
    await companions.disposeConnection(connection.companionId)
    await invoke(COMPANION_CONNECT, serverSpec({ keyPath: missing }))
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/Couldn't read the SSH private key/)
      expect(res.error).toContain(missing)
      expect(res.error).toMatch(/file not found/)
    }
    await saveGoodSecret()
  })

  test.skipIf(!(ENC_KEY && PASSPHRASE))('connects with a passphrase-protected key', async () => {
    await companions.disposeConnection(connection.companionId)
    await invoke(COMPANION_CONNECT, serverSpec({ keyPath: ENC_KEY, passphrase: PASSPHRASE }))
    // The passphrase round-trips through the encrypted secret store on read-back.
    const stored = readJson('companion-ssh-secrets.json')[connection.companionId] as { passphrase?: string }
    expect(stored.passphrase, 'passphrase should be stored encrypted, not plaintext').not.toBe(PASSPHRASE)
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    await saveGoodSecret()
  }, 60_000)

  test.skipIf(!USE_AGENT)('connects via ssh-agent (no key file)', async () => {
    await companions.disposeConnection(connection.companionId)
    await invoke(COMPANION_CONNECT, serverSpec({ useAgent: true }))
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    await saveGoodSecret()
  }, 60_000)

  test('DELETE uninstalls the daemon and unpins the host key', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(COMPANION_DELETE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    const known = readJson('companion-known-hosts.json')
    expect(Object.keys(known)).not.toContain(`${HOST}:${PORT}`)
  }, 60_000)
})

// =============================================================================
// WSL distro (Windows only — drives the WslTransport branch of buildTransport).
// =============================================================================
const LIVE_WSL = process.env.CATE_LIVE_WSL === '1' && !!process.env.CATE_LIVE_WSL_DISTRO

const WSL_DISTRO = process.env.CATE_LIVE_WSL_DISTRO ?? ''
const WSL_PATH = process.env.CATE_LIVE_WSL_PATH ?? '/root'

describe.skipIf(!LIVE_WSL)('WSL companion connect — full e2e through the IPC handlers', () => {
  let connection: Extract<CompanionConnection, { kind: 'wsl' }>

  const wslSpec = (): RemoteConnectSpec => ({ kind: 'wsl', distro: WSL_DISTRO, distroPath: WSL_PATH })

  test('CONNECT mints a stable wsl_ connection (no secret to persist)', async () => {
    const res = await invoke(COMPANION_CONNECT, wslSpec())
    expect(res.ok, JSON.stringify(res)).toBe(true)
    if (!res.ok) return
    expect(res.companionId).toMatch(/^wsl_/)
    expect(res.connection.kind).toBe('wsl')
    connection = res.connection as Extract<CompanionConnection, { kind: 'wsl' }>
  })

  test('an unknown distro is rejected with a clear message (buildTransport guard)', async () => {
    const bogus: CompanionConnection = {
      kind: 'wsl', companionId: 'wsl_bogus_0000000000', distro: 'cate-no-such-distro', distroPath: WSL_PATH,
    }
    const mark = H.captured.length
    const res = await invoke(COMPANION_ENSURE, bogus)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/not found|only available on Windows|No WSL distros/)
    expect(phasesSince(mark)).toContain('unreachable')
  })

  test('INSTALL brings the daemon up end-to-end inside the distro', async () => {
    const mark = H.captured.length
    const res = await invoke(COMPANION_INSTALL, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    expect(phasesSince(mark)).toContain('connected')
  }, 180_000)

  test('ENSURE restores from the stored connection and HOLDS without self-dropping', async () => {
    await companions.disposeConnection(connection.companionId)
    const mark = H.captured.length
    const res = await invoke(COMPANION_ENSURE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
    expect(companions.isConnected(connection.companionId)).toBe(true)
    const afterConnect = H.captured.length
    await new Promise((r) => setTimeout(r, 6000))
    const duringHold = phasesSince(afterConnect)
    expect(companions.isConnected(connection.companionId), `dropped during hold: ${JSON.stringify(duringHold)}`).toBe(true)
    expect(duringHold, 'no phase changes expected during a quiet hold').toEqual([])
    expect(phasesSince(mark)).toContain('connected')
  }, 60_000)

  test('DELETE uninstalls the daemon inside the distro', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(COMPANION_DELETE, connection)
    expect(res.ok, JSON.stringify(res)).toBe(true)
  }, 60_000)
})
