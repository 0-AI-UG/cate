// =============================================================================
// NativeAppBroker — session manager for the cate-nativehost capture sidecar.
//
// One "session" = one `cate-nativehost serve` child process talking to us over
// a UNIX-domain socket at a per-session path in os.tmpdir(). The sidecar is
// the socket SERVER (it creates/binds/listens); we connect as the client. See
// native/nativehost/PROTOCOL.md for the wire format — decoded here via
// FrameDecoder into JSON control messages (type 0x01) and raw JPEG frames
// (type 0x02), which we forward to the owning renderer window over
// NATIVE_APP_STATUS / NATIVE_APP_FRAME.
//
// acquire() resolves once the sidecar's `ready` control message arrives (the
// virtual display exists and the target app has been launched onto it) — or
// rejects on early exit / timeout. release() ends the socket (the protocol
// has the sidecar shut itself down cleanly on client disconnect), SIGTERMs
// the child as a backstop, and unlinks the socket file.
// =============================================================================

import { type ChildProcess, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import log from '../logger'
import { sendToWindow } from '../windowRegistry'
import { NATIVE_APP_FRAME, NATIVE_APP_STATUS } from '../../shared/ipc-channels'
import { CLIENT_MSG_INPUT, CLIENT_MSG_RESIZE, encodeJSONFrame } from './frameProtocol'
import type { NativeAppControlMessage } from '../../shared/types'
import { FrameDecoder } from './frameProtocol'

/** Budget for the socket to appear and accept a client connection after the
 *  sidecar is spawned (file creation + listen() is fast; this covers process
 *  startup jitter, not app launch — that's covered by READY_TIMEOUT_MS). */
const CONNECT_TIMEOUT_MS = 2000
const CONNECT_RETRY_INTERVAL_MS = 50

/** Budget for the `ready` control message to arrive after the socket connects
 *  — covers virtual display creation + launching the target app. */
const READY_TIMEOUT_MS = 15_000

/** Grace period for the sidecar to exit on its own after we close the socket,
 *  before we SIGTERM it as a backstop. */
const RELEASE_GRACE_MS = 1500

interface NativeAppSession {
  id: string
  socketPath: string
  child: ChildProcess
  socket: net.Socket | null
  decoder: FrameDecoder
  ownerWindowId: number
  /** True once release() has been called — suppresses the "sidecar exited
   *  unexpectedly" status broadcast for an exit we ourselves triggered. */
  releasing: boolean
}

const sessions = new Map<string, NativeAppSession>()

/** Resolve the cate-nativehost binary. Honors CATE_NATIVEHOST_BIN (used by
 *  tests and CI); otherwise defaults to the dev build path under the project
 *  root. Production resource-bundling is a later milestone. */
export function resolveNativeHostBinary(): string {
  const override = process.env.CATE_NATIVEHOST_BIN
  if (override) return override
  return path.join(app.getAppPath(), 'native', 'nativehost', '.build', 'debug', 'cate-nativehost')
}

/** sockaddr_un.sun_path is capped at ~104 bytes on Darwin (108 on Linux) —
 *  well short of typical filesystem path limits. macOS's os.tmpdir() is a
 *  long per-user path (/var/folders/xx/xxxxxxxx.../T), which combined with a
 *  verbose prefix + a full UUID overflows that budget outright (observed:
 *  106 chars, socket bind fails with "path too long for sockaddr_un.sun_path").
 *  Keep the filename short and fall back to /tmp — always short — if the
 *  preferred path would still be too long. */
const UNIX_SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108

function socketPathFor(sessionId: string): string {
  const shortId = sessionId.replace(/-/g, '').slice(0, 12)
  const name = `cnh-${shortId}.sock`
  const preferred = path.join(os.tmpdir(), name)
  if (preferred.length < UNIX_SOCKET_PATH_LIMIT) return preferred
  return path.join('/tmp', name)
}

function unlinkSocketFile(socketPath: string): void {
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch (err) {
    log.warn('[nativeApp] failed to unlink socket file %s: %s', socketPath, err)
  }
}

/** Connect to the sidecar's UNIX socket, retrying until it exists (the child
 *  needs a moment to create + bind + listen after spawn) or the budget expires. */
function connectWithRetry(socketPath: string, budgetMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + budgetMs
    const attempt = (): void => {
      const socket = net.createConnection(socketPath)
      const onError = (err: Error): void => {
        socket.removeAllListeners()
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`could not connect to ${socketPath} within ${budgetMs}ms: ${err.message}`))
          return
        }
        setTimeout(attempt, CONNECT_RETRY_INTERVAL_MS)
      }
      socket.once('error', onError)
      socket.once('connect', () => {
        socket.removeListener('error', onError)
        resolve(socket)
      })
    }
    attempt()
  })
}

function emitStatus(sessionId: string, ownerWindowId: number, control: NativeAppControlMessage): void {
  try {
    sendToWindow(ownerWindowId, NATIVE_APP_STATUS, { sessionId, control })
  } catch (err) {
    log.warn('[nativeApp] failed to send status for session %s: %s', sessionId, err)
  }
}

function emitFrame(sessionId: string, ownerWindowId: number, jpeg: Buffer): void {
  try {
    sendToWindow(ownerWindowId, NATIVE_APP_FRAME, { sessionId, jpeg })
  } catch (err) {
    log.warn('[nativeApp] failed to send frame for session %s: %s', sessionId, err)
  }
}

/**
 * Spawn a cate-nativehost session for `bundleId`, wire its socket through the
 * frame decoder, and forward frames/control messages to `ownerWindowId`.
 * Resolves with the new session id once the sidecar reports `ready`, or an
 * `{ error }` result if the sidecar exits early or never becomes ready in time.
 */
export async function acquire(
  options: { bundleId: string; width?: number; height?: number; fps?: number },
  ownerWindowId: number,
): Promise<{ sessionId: string } | { error: string }> {
  const sessionId = randomUUID()
  const socketPath = socketPathFor(sessionId)
  const bin = resolveNativeHostBinary()

  const args = ['serve', '--bundle', options.bundleId, '--socket', socketPath]
  if (options.width != null) args.push('--width', String(options.width))
  if (options.height != null) args.push('--height', String(options.height))
  if (options.fps != null) args.push('--fps', String(options.fps))

  let child: ChildProcess
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    return { error: `failed to spawn cate-nativehost: ${err instanceof Error ? err.message : String(err)}` }
  }

  const session: NativeAppSession = {
    id: sessionId,
    socketPath,
    child,
    socket: null,
    decoder: new FrameDecoder(),
    ownerWindowId,
    releasing: false,
  }
  sessions.set(sessionId, session)

  child.stderr?.on('data', (chunk: Buffer) => {
    log.warn('[nativeApp] %s stderr: %s', sessionId, chunk.toString('utf8').trim())
  })

  // Supervise unexpected exit for the lifetime of the session (wired once,
  // regardless of whether acquire ultimately succeeds).
  child.on('exit', (code, signal) => {
    const s = sessions.get(sessionId)
    sessions.delete(sessionId)
    if (!s || s.releasing) return
    log.warn('[nativeApp] %s sidecar exited unexpectedly (code=%s signal=%s)', sessionId, code, signal)
    emitStatus(sessionId, s.ownerWindowId, { t: 'error', message: 'sidecar exited' })
  })

  return new Promise((resolve) => {
    let settled = false
    const settle = (result: { sessionId: string } | { error: string }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const earlyExitHandler = (code: number | null, signal: NodeJS.Signals | null): void => {
      settle({ error: `cate-nativehost exited before ready (code=${code ?? 'null'} signal=${signal ?? 'null'})` })
    }
    child.once('exit', earlyExitHandler)

    const readyTimer = setTimeout(() => {
      settle({ error: `timed out waiting for cate-nativehost ready after ${READY_TIMEOUT_MS}ms` })
    }, READY_TIMEOUT_MS)

    void connectWithRetry(socketPath, CONNECT_TIMEOUT_MS)
      .then((socket) => {
        session.socket = socket

        socket.on('data', (chunk: Buffer) => {
          const messages = session.decoder.push(chunk)
          for (const msg of messages) {
            if (msg.type === 0x01) {
              let control: NativeAppControlMessage
              try {
                control = JSON.parse(msg.payload.toString('utf8')) as NativeAppControlMessage
              } catch (err) {
                log.warn('[nativeApp] %s malformed control message: %s', sessionId, err)
                continue
              }
              emitStatus(sessionId, session.ownerWindowId, control)
              if (control.t === 'ready') {
                clearTimeout(readyTimer)
                child.removeListener('exit', earlyExitHandler)
                settle({ sessionId })
              }
            } else if (msg.type === 0x02) {
              emitFrame(sessionId, session.ownerWindowId, msg.payload)
            }
            // Unknown types: already forwarded via emitStatus for 0x01 above,
            // otherwise silently ignored per PROTOCOL.md's forward-compat note.
          }
        })

        socket.on('error', (err) => {
          log.warn('[nativeApp] %s socket error: %s', sessionId, err.message)
        })

        socket.on('close', () => {
          session.socket = null
        })
      })
      .catch((err: Error) => {
        clearTimeout(readyTimer)
        child.removeListener('exit', earlyExitHandler)
        log.warn('[nativeApp] %s failed to connect: %s', sessionId, err.message)
        try { child.kill('SIGTERM') } catch { /* already gone */ }
        settle({ error: err.message })
      })
  })
}

/** End a session: close our end of the socket (the sidecar shuts itself down
 *  cleanly on disconnect per PROTOCOL.md), SIGTERM the child as a backstop if
 *  it lingers, unlink the socket file, and drop bookkeeping. */
export async function release(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return
  session.releasing = true
  sessions.delete(sessionId)

  await new Promise<void>((resolve) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    if (session.child.exitCode !== null || session.child.signalCode !== null) {
      done()
      return
    }

    session.child.once('exit', done)

    try {
      session.socket?.end()
      session.socket?.destroy()
    } catch { /* already closed */ }

    const timer = setTimeout(() => {
      try { session.child.kill('SIGTERM') } catch { /* already gone */ }
      done()
    }, RELEASE_GRACE_MS)
  })

  unlinkSocketFile(session.socketPath)
}

/** Forward an input event (mouse/keyboard/scroll) to a session's sidecar.
 *  Silently ignores unknown/closed sessions — input for a torn-down panel is
 *  expected during teardown races. */
export function sendInput(sessionId: string, event: unknown): void {
  const session = sessions.get(sessionId)
  if (!session?.socket) return
  try {
    session.socket.write(encodeJSONFrame(CLIENT_MSG_INPUT, event))
  } catch (err) {
    log.warn('[nativeApp] failed to send input for session %s: %s', sessionId, err)
  }
}

/** Ask a session's sidecar to resize the captured app window to
 *  `width`×`height` points (and reconfigure capture to match). */
export function sendResize(sessionId: string, width: number, height: number): void {
  const session = sessions.get(sessionId)
  if (!session?.socket) return
  try {
    session.socket.write(encodeJSONFrame(CLIENT_MSG_RESIZE, { w: Math.round(width), h: Math.round(height) }))
  } catch (err) {
    log.warn('[nativeApp] failed to send resize for session %s: %s', sessionId, err)
  }
}

/** Tear down every live session — called on app quit. */
export async function releaseAll(): Promise<void> {
  await Promise.allSettled([...sessions.keys()].map((id) => release(id)))
}

/** Test/diagnostic hook: number of live sessions. */
export function liveSessionCount(): number {
  return sessions.size
}
