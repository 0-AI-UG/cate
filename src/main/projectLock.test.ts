import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  acquireProjectLock,
  releaseProjectLock,
  releaseAllProjectLocks,
  holdsProjectLock,
} from './projectLock'

describe('projectLock', () => {
  let root: string
  const lockFile = () => path.join(root, '.cate', 'workspace.lock')
  const writeOwner = (pid: number) => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true })
    fs.writeFileSync(lockFile(), JSON.stringify({ pid }))
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-lock-'))
  })
  afterEach(() => {
    releaseAllProjectLocks()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('acquires a free lock and records our pid', () => {
    expect(acquireProjectLock(root)).toBe(true)
    expect(holdsProjectLock(root)).toBe(true)
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf-8')).pid).toBe(process.pid)
  })

  it('reclaims a lock left by a dead pid', () => {
    writeOwner(999999) // overwhelmingly unlikely to be alive
    expect(acquireProjectLock(root)).toBe(true)
  })

  it('refuses a lock held by a live pid', () => {
    // The parent process is alive for the test and isn't our own pid.
    writeOwner(process.ppid)
    expect(acquireProjectLock(root)).toBe(false)
    expect(holdsProjectLock(root)).toBe(false)
  })

  it('release deletes our lock file', () => {
    acquireProjectLock(root)
    releaseProjectLock(root)
    expect(fs.existsSync(lockFile())).toBe(false)
  })

  it('release leaves a lock owned by someone else', () => {
    acquireProjectLock(root)
    writeOwner(process.ppid)
    releaseProjectLock(root)
    expect(fs.existsSync(lockFile())).toBe(true)
  })
})
