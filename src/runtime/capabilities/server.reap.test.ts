// =============================================================================
// Focused test for reapOrphanServers() (electron-free, no mocks). Writes a pid
// file (via the same path scheme the capability uses) pointing at a live dummy
// child, runs the reap, and asserts the child is killed and the file cleared. A
// stale/nonexistent pid is ignored without throwing.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { reapOrphanServers, serverPidFilePath } from './server'

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
