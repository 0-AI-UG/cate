// =============================================================================
// Focused test for reapOrphanServers() (electron-free, no mocks). Writes a pid
// file (via the same path scheme the capability uses) pointing at a live dummy
// child, runs the reap, and asserts the child is killed and the file cleared. A
// stale/nonexistent pid is ignored without throwing.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { createServerCapability, reapOrphanServers, serverPidFilePath } from './server'

const DAEMON_ID = 'reap-test'

function spawnDummy(): ChildProcess {
  // A long-lived child that does nothing until killed.
  return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

const spawned: ChildProcess[] = []
afterEach(() => {
  for (const c of spawned) { try { c.kill('SIGKILL') } catch { /* gone */ } }
  spawned.length = 0
  vi.unstubAllEnvs()
  try { fs.rmSync(serverPidFilePath(DAEMON_ID), { force: true }) } catch { /* gone */ }
})

describe('reapOrphanServers', () => {
  it('kills a recorded live child and clears the pid file', async () => {
    const child = spawnDummy()
    spawned.push(child)
    await new Promise<void>((resolve) => child.on('spawn', resolve))
    const pid = child.pid!
    expect(isAlive(pid)).toBe(true)

    const file = serverPidFilePath(DAEMON_ID)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify([{ pid, id: 'srv1', startedAt: Date.now() }]))

    reapOrphanServers(DAEMON_ID)

    // The pid file is cleared (removed) after reaping.
    expect(fs.existsSync(file)).toBe(false)

    // The child receives SIGKILL; wait for the exit to land.
    await new Promise<void>((resolve) => {
      if (!isAlive(pid)) return resolve()
      child.on('close', () => resolve())
    })
    expect(isAlive(pid)).toBe(false)
  })

  it('ignores a stale/nonexistent pid without throwing', () => {
    const file = serverPidFilePath(DAEMON_ID)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // A pid that almost certainly does not exist.
    fs.writeFileSync(file, JSON.stringify([{ pid: 2147483647, id: 'gone', startedAt: 0 }]))

    expect(() => reapOrphanServers(DAEMON_ID)).not.toThrow()
    expect(fs.existsSync(file)).toBe(false)
  })

  it('is a no-op when there is no pid file', () => {
    const file = serverPidFilePath('never-existed')
    try { fs.rmSync(file, { force: true }) } catch { /* gone */ }
    expect(() => reapOrphanServers('never-existed')).not.toThrow()
  })
})


it('isolates E2E server bookkeeping from the installed app even with the same daemon id', () => {
  vi.stubEnv('CATE_E2E', '')
  const installed = serverPidFilePath('local')
  vi.stubEnv('CATE_E2E', '1')
  vi.stubEnv('CATE_E2E_USER_DATA', '/tmp/cate-private-test/userdata')
  const testApp = serverPidFilePath('local')
  expect(testApp).not.toBe(installed)
  expect(testApp).toBe(path.join('/tmp/cate-private-test/userdata', 'cate-runtime', 'ext-servers-local.json'))
})


it('preserves a server and its bookkeeping while its owning daemon is alive', async () => {
  const child = spawnDummy()
  spawned.push(child)
  await new Promise<void>((resolve) => child.once('spawn', resolve))
  const file = serverPidFilePath(DAEMON_ID)
  const records = [{ pid: child.pid!, id: 'owned', startedAt: Date.now(), ownerPid: process.pid }]
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(records))

  reapOrphanServers(DAEMON_ID)

  expect(isAlive(child.pid!)).toBe(true)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(records)
})

it('reaps an orphan while retaining a sibling server with a live owner', async () => {
  const owner = spawnDummy()
  const orphan = spawnDummy()
  const live = spawnDummy()
  spawned.push(owner, orphan, live)
  await Promise.all([owner, orphan, live].map(child => new Promise<void>(resolve => child.once('spawn', resolve))))
  const ownerClosed = new Promise<void>(resolve => owner.once('close', () => resolve()))
  owner.kill('SIGKILL')
  await ownerClosed
  const file = serverPidFilePath(DAEMON_ID)
  const retained = { pid: live.pid!, id: 'live', startedAt: Date.now(), ownerPid: process.pid }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify([
    { pid: orphan.pid!, id: 'orphan', startedAt: Date.now(), ownerPid: owner.pid! }, retained,
  ]))
  const orphanClosed = new Promise<void>(resolve => orphan.once('close', () => resolve()))

  reapOrphanServers(DAEMON_ID)
  await orphanClosed

  expect(isAlive(orphan.pid!)).toBe(false)
  expect(isAlive(live.pid!)).toBe(true)
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([retained])
})


it('records ownership for a real server and keeps it serving through startup cleanup', async () => {
  const server = createServerCapability({ daemonId: DAEMON_ID })
  let finishExit!: () => void
  const exited = new Promise<void>(resolve => { finishExit = resolve })
  try {
    const handle = await server.start({
      id: 'ownership-test',
      command: [process.execPath, '-e', "require('http').createServer((q,s)=>s.end('alive')).listen(process.env.PORT,'127.0.0.1')"],
      cwd: process.cwd(), env: {}, portEnv: 'PORT', readyPath: '/', readyTimeoutMs: 5000,
    }, () => {}, () => finishExit())
    const records = JSON.parse(fs.readFileSync(serverPidFilePath(DAEMON_ID), 'utf8'))
    expect(records).toEqual([expect.objectContaining({ pid: handle.pid, ownerPid: process.pid })])

    reapOrphanServers(DAEMON_ID)

    const response = await fetch(`http://127.0.0.1:${handle.port}`)
    expect(await response.text()).toBe('alive')
  } finally {
    server.killAll()
    await exited
  }
})
