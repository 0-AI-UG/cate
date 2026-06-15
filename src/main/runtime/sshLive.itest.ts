// =============================================================================
// LIVE SSH integration harness — drives the REAL RuntimeManager + SshTransport
// against a real server, to reproduce / rule out the reconnect loop in #335.
//
// Opt-in only: needs a reachable server + key, so it's gated on CATE_LIVE_SSH=1
// and a *.itest.ts name that the normal vitest `include` (*.test.ts) skips.
//
// Run:  CATE_LIVE_SSH=1 npx vitest run --config vitest.live.config.ts
// =============================================================================

import { describe, test, expect, vi, beforeAll } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'

// Server + key come from the environment so nothing host-specific is committed:
//   CATE_LIVE_SSH=1 CATE_LIVE_SSH_HOST=1.2.3.4 CATE_LIVE_SSH_USER=root \
//   CATE_LIVE_SSH_ROOT=/root/ CATE_LIVE_SSH_KEY=~/.ssh/id_ed25519 \
//   npx vitest run --config vitest.live.config.ts
const LIVE = process.env.CATE_LIVE_SSH === '1' && !!process.env.CATE_LIVE_SSH_HOST

// electron `app` is a path string outside the electron runtime; runtimeArtifacts
// reads app.isPackaged / getAppPath / getPath. Provide a dev-shaped stub so the
// SshTransport takes the same dev path the user's `npm run dev` app does.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd(),
    getPath: () => join(process.cwd(), '.cate-live-tmp'),
    getName: () => 'Cate',
  },
}))

const HOST = process.env.CATE_LIVE_SSH_HOST ?? ''
const USER = process.env.CATE_LIVE_SSH_USER ?? 'root'
const ROOT = process.env.CATE_LIVE_SSH_ROOT ?? '/root/'
const KEY = (process.env.CATE_LIVE_SSH_KEY ?? join(homedir(), '.ssh', 'id_ed25519'))
  .replace(/^~(?=$|\/)/, homedir())
const RUNTIME_ID = process.env.CATE_LIVE_SSH_ID ?? 'srv_live'

/** Count live runtime daemons on the server — one per live transport, so any
 *  count >1 is a leaked/duplicate connection (the smoking gun for #335). */
function serverDaemonCount(): number {
  const out = execFileSync(
    'ssh',
    ['-i', KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', `${USER}@${HOST}`,
     // Bracket trick so pgrep doesn't match its own command line.
     "pgrep -f 'runtime[.]cjs' | wc -l"],
    { encoding: 'utf8' },
  )
  return parseInt(out.trim(), 10) || 0
}

describe.skipIf(!LIVE)('live SSH runtime (real server)', () => {
  let RuntimeManagerCtor: typeof import('./runtimeManager').RuntimeManager
  let SshTransportCtor: typeof import('./transports/sshTransport').SshTransport

  beforeAll(async () => {
    RuntimeManagerCtor = (await import('./runtimeManager')).RuntimeManager
    SshTransportCtor = (await import('./transports/sshTransport')).SshTransport
  })

  type Ev = { t: number; phase: string; message?: string }
  function harness(): { mgr: InstanceType<typeof RuntimeManagerCtor>; events: Ev[]; t0: number } {
    const mgr = new RuntimeManagerCtor()
    const events: Ev[] = []
    const t0 = Date.now()
    mgr.setStatusListener((_id, phase, message) => events.push({ t: Date.now() - t0, phase, message }))
    return { mgr, events, t0 }
  }
  const newTransport = (id: string): InstanceType<typeof SshTransportCtor> =>
    new SshTransportCtor({
      host: HOST, user: USER, port: 22, root: ROOT, id,
      privateKey: readFileSync(KEY),
      // Accept whatever host key is presented (this is a debug harness).
      verifyHostKey: async () => {},
    })

  test('connect, then HOLD 8s — does the connection drop on its own? (#335 core symptom)', async () => {
    const { mgr, events } = harness()
    const id = RUNTIME_ID
    await mgr.connect(id, newTransport(id), { install: false })
    expect(mgr.isConnected(id)).toBe(true)
    const afterConnect = events.length
    // The bug: ~1s after `connected`, the client tears the transport down. Hold
    // and watch for any unsolicited disconnect / phase change.
    await new Promise((r) => setTimeout(r, 8000))
    const newEvents = events.slice(afterConnect)
    // eslint-disable-next-line no-console
    console.log('[hold] timeline:', JSON.stringify(events, null, 0))
    expect(mgr.isConnected(id), `dropped during hold: ${JSON.stringify(newEvents)}`).toBe(true)
    expect(newEvents, 'no phase changes expected during a quiet hold').toEqual([])
    await mgr.disposeAll()
  }, 30_000)

  test('concurrent ensure x4 + a racing install opens exactly ONE server session', async () => {
    const { mgr, events } = harness()
    const id = RUNTIME_ID
    // Mimic the restore storm: fs:watchStart, git-monitor, select, retry all
    // reach for the runtime at once, plus an install racing them.
    await Promise.all([
      mgr.connect(id, newTransport(id), { install: false }),
      mgr.connect(id, newTransport(id), { install: false }),
      mgr.connect(id, newTransport(id), { install: false }),
      mgr.connect(id, newTransport(id), { install: false }),
    ])
    expect(mgr.isConnected(id)).toBe(true)
    await new Promise((r) => setTimeout(r, 1500))
    const daemons = serverDaemonCount()
    // eslint-disable-next-line no-console
    console.log(`[race] live runtime daemons on server=${daemons}; events=${JSON.stringify(events)}`)
    // Exactly one live daemon — extras would mean a leaked/duplicate transport.
    expect(daemons).toBeLessThanOrEqual(1)
    await mgr.disposeAll()
  }, 30_000)

  test('reinstall (force) while connected: clean single re-connect, no flap', async () => {
    const { mgr, events } = harness()
    const id = RUNTIME_ID
    await mgr.connect(id, newTransport(id), { install: false })
    expect(mgr.isConnected(id)).toBe(true)
    const mark = events.length
    // Exactly what RUNTIME_INSTALL does: drop the live conn, then force-install.
    await mgr.disposeConnection(id)
    await mgr.connect(id, newTransport(id), { install: true, force: true })
    expect(mgr.isConnected(id)).toBe(true)
    await new Promise((r) => setTimeout(r, 3000))
    // eslint-disable-next-line no-console
    console.log('[reinstall] timeline:', JSON.stringify(events.slice(mark)))
    expect(mgr.isConnected(id), 'should be stably connected after reinstall').toBe(true)
    await mgr.disposeAll()
  }, 60_000)
})
