import fs from 'fs'
import path from 'path'
import { createHash, randomUUID } from 'node:crypto'
import { writeJsonExclusiveSync } from '../shared/atomicFile'
import log from './logger'

// Per-project leases prevent independent Cate userData instances from writing
// the same session. Publish a complete immutable owner record exclusively;
// neither a cached claim nor an I/O failure grants permission to write.
interface Lease { pid: number; token?: string }
interface LeaseSnapshot { owner: Lease; identity: string }
const heldRoots = new Map<string, string>()
const lockPath = (root: string): string => path.join(root, '.cate', 'workspace.lock')

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

function readLease(file: string): LeaseSnapshot | null {
  let fd: number
  try { fd = fs.openSync(file, 'r') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
  try {
    const stat = fs.fstatSync(fd)
    const raw = fs.readFileSync(fd, 'utf8')
    const owner = JSON.parse(raw) as Lease
    if (!Number.isInteger(owner?.pid) || owner.pid <= 0) throw new Error(`Invalid project lease: ${file}`)
    return { owner, identity: `${stat.dev}:${stat.ino}:${raw}` }
  } finally { fs.closeSync(fd) }
}

function releaseLease(file: string, token: string): void {
  try {
    const current = readLease(file)?.owner
    if (current?.pid === process.pid && current.token === token) fs.unlinkSync(file)
  } catch { /* fail closed; a later acquire can recover a dead owner */ }
}

function claimLease(file: string, depth = 0): string | null {
  // Repeated deaths while reclaiming a dead reaper can create a short chain.
  // Bound exceptional recovery work; never time out or steal a live lease.
  if (depth > 16) return null
  const token = randomUUID()
  if (writeJsonExclusiveSync(file, { pid: process.pid, token })) return token
  const previous = readLease(file)
  if (!previous) return claimLease(file, depth + 1)
  if (isProcessAlive(previous.owner.pid)) return null

  // All contenders for this exact stale inode use the same exclusive claim.
  // A crashed reaper is itself a dead lease, recovered by the same protocol.
  // Rechecking under that claim prevents a delayed contender removing a newer
  // lease after another contender already reclaimed the old one.
  const key = createHash('sha256').update(`${file}\0${previous.identity}`).digest('hex')
  const guard = path.join(path.dirname(file), `.workspace-lock-reap-${key}`)
  const guardToken = claimLease(guard, depth + 1)
  if (!guardToken) return null
  try {
    if (readLease(file)?.identity !== previous.identity) return null
    fs.unlinkSync(file)
    return writeJsonExclusiveSync(file, { pid: process.pid, token }) ? token : null
  } finally { releaseLease(guard, guardToken) }
}

export function acquireProjectLock(rootPath: string): boolean {
  const root = path.resolve(rootPath)
  if (holdsProjectLock(root)) return true
  try {
    const token = claimLease(lockPath(root))
    if (!token) return false
    heldRoots.set(root, token)
    return true
  } catch (error) {
    log.warn('projectLock: cannot establish ownership for %s: %O', root, error)
    return false
  }
}

export function holdsProjectLock(rootPath: string): boolean {
  const root = path.resolve(rootPath)
  const token = heldRoots.get(root)
  if (!token) return false
  try {
    const current = readLease(lockPath(root))?.owner
    if (current?.pid === process.pid && current.token === token) return true
  } catch { /* unreadable ownership is not authority */ }
  heldRoots.delete(root)
  return false
}

export function releaseProjectLock(rootPath: string): void {
  const root = path.resolve(rootPath)
  const token = heldRoots.get(root)
  heldRoots.delete(root)
  if (token) releaseLease(lockPath(root), token)
}

export function releaseAllProjectLocks(): void {
  for (const root of [...heldRoots.keys()]) releaseProjectLock(root)
}
