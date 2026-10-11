// SSH prompts (a password, a passphrase, a one-time code) answered in the
// app: ssh runs `SSH_ASKPASS` for each prompt instead of reading a terminal.
// The helper is this app's Node (Electron as Node) running a tiny script that
// sends the prompt over a socket in a private folder and prints the answer.
// Each machine gets one shared connection (ControlMaster), so a password is
// asked once, not for every command. Not on Windows: its OpenSSH shares no
// connections, so it stays keys and agent only.

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { machineLabel, type Machine } from '../contract'

/** What ssh needs to ask through the app. */
export interface SshPrompting {
  /** The environment of an ssh command for `machine`. */
  env(machine: Machine): NodeJS.ProcessEnv
  /** ssh's ControlPath for shared connections. */
  controlPath: string
}

export interface AskpassServer extends SshPrompting {
  close(): Promise<void>
}

/** Prints the answer, or exits 1 when the person cancelled. */
const HELPER = `const net = require('net')
const socket = net.connect(process.env.CATE_ASKPASS_SOCKET)
let reply = ''
socket.setEncoding('utf8')
socket.on('data', (chunk) => { reply += chunk })
socket.on('error', () => process.exit(1))
socket.on('end', () => {
  const { answer } = JSON.parse(reply || '{}')
  if (typeof answer !== 'string') process.exit(1)
  process.stdout.write(answer + '\\n')
})
socket.end(JSON.stringify({ prompt: process.argv[2] || '', machine: process.env.CATE_ASKPASS_MACHINE || '' }))
`

/** Writes the helper and listens; throws when it cannot. */
export function startAskpass(opts: {
  /** A folder only this user can read (the socket and helper live there). */
  dir: string
  /** The Node that runs the helper: Electron's binary as Node. */
  node: string
  /** Asks the person; null when they cancel. `signal` aborts when ssh no
   *  longer waits (its helper went away). */
  ask(request: { machine: string; prompt: string }, signal: AbortSignal): Promise<string | null>
  onError?(error: Error): void
}): AskpassServer {
  fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(opts.dir, 0o700)
  const helper = path.join(opts.dir, 'askpass.js')
  const script = path.join(opts.dir, 'askpass')
  const socketPath = path.join(opts.dir, `askpass-${process.pid}.sock`)
  fs.writeFileSync(helper, HELPER, { mode: 0o600 })
  fs.writeFileSync(script, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$CATE_ASKPASS_NODE" "$CATE_ASKPASS_HELPER" "$@"\n', { mode: 0o700 })
  fs.rmSync(socketPath, { force: true })

  // Half-open: the helper ends its side once it has sent the prompt.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let request = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { request += chunk })
    socket.on('error', () => {})
    const gone = new AbortController()
    socket.on('close', () => gone.abort())
    socket.on('end', () => {
      let parsed: { prompt?: unknown; machine?: unknown }
      try { parsed = JSON.parse(request) as typeof parsed } catch { return void socket.end('{}') }
      opts.ask({ machine: String(parsed.machine ?? ''), prompt: String(parsed.prompt ?? '') }, gone.signal).then(
        (answer) => socket.end(JSON.stringify({ answer })),
        () => socket.end('{}'),
      )
    })
  })
  server.on('error', (error) => opts.onError?.(error))
  server.listen(socketPath)

  return {
    controlPath: path.join(opts.dir, '%C'),
    env: (machine) => ({
      ...process.env,
      SSH_ASKPASS: script,
      // ssh 8.4+; an older one keeps to keys and the agent.
      SSH_ASKPASS_REQUIRE: 'force',
      CATE_ASKPASS_NODE: opts.node,
      CATE_ASKPASS_HELPER: helper,
      CATE_ASKPASS_SOCKET: socketPath,
      CATE_ASKPASS_MACHINE: machineLabel(machine),
    }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
