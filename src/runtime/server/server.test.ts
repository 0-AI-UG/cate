import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { RUNTIME_NODE_EXECUTABLE } from './contract'
import { createServerHost, reapOrphanServers, type ServerHost } from './runtime'

let dir: string
let host: ServerHost
let pidFile: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-server-'))
  pidFile = path.join(dir, 'servers.json')
  host = createServerHost({ pidFile, installDir: dir, nodePath: process.execPath })
})

afterEach(() => {
  host.killAll()
  fs.rmSync(dir, { recursive: true, force: true })
})

// Listens only after a delay, so the probe has to retry.
const httpServer = `
  const http = require('http')
  console.log('booting')
  setTimeout(() => http.createServer((q, s) => s.end('up')).listen(Number(process.env.APP_PORT), '127.0.0.1'), 300)
`

it('resolves once the server answers its ready path', async () => {
  const output: string[] = []
  const handle = await host.start(
    { command: [RUNTIME_NODE_EXECUTABLE, '-e', httpServer], cwd: dir, portEnv: 'APP_PORT', readyPath: '/ready', readyTimeoutMs: 5000 },
    (_id, _stream, chunk) => output.push(chunk),
    () => {},
  )
  expect(handle.port).toBeGreaterThan(0)
  expect(await (await fetch(`http://127.0.0.1:${handle.port}/`)).text()).toBe('up')
  expect(output.join('')).toContain('booting')
  expect(JSON.parse(fs.readFileSync(pidFile, 'utf-8'))).toEqual([expect.objectContaining({ pid: handle.pid, ownerPid: process.pid })])

  const exited = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      try { process.kill(handle.pid, 0) } catch { clearInterval(timer); resolve() }
    }, 20)
  })
  host.stop(handle.id)
  await exited
  expect(host.running()).toBe(0)
})

it('rejects with the output when the server exits before ready', async () => {
  const start = host.start(
    { command: [RUNTIME_NODE_EXECUTABLE, '-e', 'console.error("port taken"); process.exit(3)'], cwd: dir, portEnv: 'P', readyPath: '/', readyTimeoutMs: 5000 },
    () => {},
    () => {},
  )
  await expect(start).rejects.toThrow(/exited before ready \(code 3[\s\S]*port taken/)
})

it('rejects when the ready probe times out', async () => {
  const start = host.start(
    { command: [RUNTIME_NODE_EXECUTABLE, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, portEnv: 'P', readyPath: '/', readyTimeoutMs: 400 },
    () => {},
    () => {},
  )
  await expect(start).rejects.toThrow(/timed out after 400ms/)
})

it('reaps children whose daemon is gone', async () => {
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const deadOwner = 2 ** 22 + 12345
  fs.writeFileSync(pidFile, JSON.stringify([{ pid: orphan.pid, id: 'x', startedAt: 0, ownerPid: deadOwner }]))
  const exited = new Promise((resolve) => orphan.once('exit', resolve))
  reapOrphanServers(pidFile)
  await exited
  expect(fs.existsSync(pidFile)).toBe(false)
})
