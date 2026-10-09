// Linux /proc readers standing in for the ps/lsof spawns of the process scan
// (procScan.ts). Forking ps/lsof about twice a second is heavy on Linux (#246);
// reading /proc is plain async file I/O. The comm in /proc/<pid>/stat is the
// same 15-char name `ps -o comm=` prints on Linux.

import { readdir, readFile, readlink } from 'node:fs/promises'

export interface ProcTree {
  /** comm basename, keyed by pid. */
  nameByPid: Map<number, string>
  /** direct child pids, keyed by parent pid. */
  childrenByPid: Map<number, number[]>
}

/**
 * Parse one /proc/<pid>/stat line: "<pid> (<comm>) <state> <ppid> <pgrp> ...".
 * comm is wrapped in parens and may itself contain spaces and parens, so anchor
 * on the LAST ')': everything after "<close>) " is space-separated, with state
 * at index 0 and ppid at index 1.
 */
export function parseStat(content: string): { ppid: number; comm: string } | null {
  const open = content.indexOf('(')
  const close = content.lastIndexOf(')')
  if (open < 0 || close < 0 || close < open) return null
  const comm = content.slice(open + 1, close)
  const after = content.slice(close + 2).split(' ')
  const ppid = parseInt(after[1], 10)
  if (isNaN(ppid)) return null
  return { ppid, comm }
}

/** ONE pass over /proc — the no-fork equivalent of `ps -axo pid=,ppid=,comm=`. */
export async function snapshotProcessTreeProc(): Promise<ProcTree> {
  const nameByPid = new Map<number, string>()
  const childrenByPid = new Map<number, number[]>()
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return { nameByPid, childrenByPid }
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) return
      let content: string
      try {
        content = await readFile(`/proc/${entry}/stat`, 'utf-8')
      } catch {
        return // process exited between readdir and read
      }
      const parsed = parseStat(content)
      if (!parsed) return
      const pid = parseInt(entry, 10)
      nameByPid.set(pid, parsed.comm)
      const siblings = childrenByPid.get(parsed.ppid)
      if (siblings) siblings.push(pid)
      else childrenByPid.set(parsed.ppid, [pid])
    }),
  )
  return { nameByPid, childrenByPid }
}

/** The pty's cwd — readlink of /proc/<pid>/cwd (the lsof -d cwd equivalent). */
export async function getCwdProc(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

const TCP_LISTEN = '0A'

/**
 * Parse /proc/net/tcp{,6} into a socket-inode → listening-port map.
 * Each row's local_address is "HEXIP:HEXPORT", st (field 3) is the TCP state
 * (0A = LISTEN), and field 9 is the socket inode — the same inode that shows up
 * as `socket:[<inode>]` behind a process fd.
 */
export function parseListeningInodes(content: string): Map<number, number> {
  const map = new Map<number, number>()
  const lines = content.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/)
    if (f.length < 10 || f[3] !== TCP_LISTEN) continue
    const portHex = f[1].split(':')[1]
    const inode = parseInt(f[9], 10)
    if (!portHex || isNaN(inode)) continue
    const port = parseInt(portHex, 16)
    if (isNaN(port)) continue
    if (!map.has(inode)) map.set(inode, port) // one listening inode → one port
  }
  return map
}

async function listeningInodeToPort(): Promise<Map<number, number>> {
  const merged = new Map<number, number>()
  await Promise.all(
    ['/proc/net/tcp', '/proc/net/tcp6'].map(async (file) => {
      let content: string
      try {
        content = await readFile(file, 'utf-8')
      } catch {
        return
      }
      for (const [inode, port] of parseListeningInodes(content)) {
        if (!merged.has(inode)) merged.set(inode, port)
      }
    }),
  )
  return merged
}

/**
 * Listening TCP ports per pid, the no-fork equivalent of the `lsof -iTCP -sTCP:LISTEN
 * -p <pids>` scan: cross the listening-inode table with each pid's open socket fds
 * (/proc/<pid>/fd/* → socket:[<inode>]). The caller maps pids back to their pty.
 */
export async function listeningPortsByPidProc(pids: number[]): Promise<Map<number, number[]>> {
  const inodeToPort = await listeningInodeToPort()
  const result = new Map<number, number[]>()
  if (inodeToPort.size === 0) return result
  await Promise.all(
    pids.map(async (pid) => {
      let fds: string[]
      try {
        fds = await readdir(`/proc/${pid}/fd`)
      } catch {
        return // process gone, or fds not readable
      }
      const ports: number[] = []
      await Promise.all(
        fds.map(async (fd) => {
          let target: string
          try {
            target = await readlink(`/proc/${pid}/fd/${fd}`)
          } catch {
            return
          }
          const m = target.match(/^socket:\[(\d+)\]$/)
          if (!m) return
          const port = inodeToPort.get(parseInt(m[1], 10))
          if (port != null && !ports.includes(port)) ports.push(port)
        }),
      )
      if (ports.length > 0) result.set(pid, ports)
    }),
  )
  return result
}
