import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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
    vi.restoreAllMocks()
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


describe('project lease authority', () => {
  it('does not claim ownership when lock publication fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-lock-failure-'))
    try {
      fs.writeFileSync(path.join(root, '.cate'), 'not a directory')
      expect(acquireProjectLock(root)).toBe(false)
      expect(holdsProjectLock(root)).toBe(false)
    } finally { releaseAllProjectLocks(); fs.rmSync(root, { recursive: true, force: true }) }
  })
  it('does not trust cached ownership after replacement by another live owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-lock-owner-'))
    try {
      expect(acquireProjectLock(root)).toBe(true)
      fs.writeFileSync(path.join(root, '.cate/workspace.lock'), JSON.stringify({ pid: process.ppid }))
      expect(holdsProjectLock(root)).toBe(false)
    } finally { releaseAllProjectLocks(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})

it('cannot overwrite a competing claimant that publishes at the acquisition boundary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-lock-race-'))
  const file = path.join(root, '.cate/workspace.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const write = fs.writeFileSync
  const link = fs.linkSync
  let competed = false
  const compete = () => {
    if (competed) return
    competed = true
    write(file, JSON.stringify({ pid: process.ppid, token: 'competing-owner' }))
  }
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...args: any[]) => {
    if (String(target) === file) compete()
    return (write as any)(target, ...args)
  }) as typeof fs.writeFileSync)
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === file) compete()
    return link(from, to)
  })
  try {
    expect(acquireProjectLock(root)).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.ppid)
  } finally { vi.restoreAllMocks(); releaseAllProjectLocks(); fs.rmSync(root, { recursive: true, force: true }) }
})

it('recovers when the process reclaiming a stale lease also crashed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cate-lock-reaper-'))
  const file = path.join(root, '.cate/workspace.lock')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, token: 'dead-owner' }))
  const link = fs.linkSync
  let injected = false
  vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (!injected && path.basename(String(to)).startsWith('.workspace-lock-reap-')) {
      injected = true
      fs.writeFileSync(to, JSON.stringify({ pid: 999999, token: 'dead-reaper' }))
    }
    return link(from, to)
  })
  try {
    expect(acquireProjectLock(root)).toBe(true)
    expect(injected).toBe(true)
    expect(holdsProjectLock(root)).toBe(true)
    expect(fs.readdirSync(path.dirname(file))).toEqual(['workspace.lock'])
  } finally { vi.restoreAllMocks(); releaseAllProjectLocks(); fs.rmSync(root, { recursive: true, force: true }) }
})
