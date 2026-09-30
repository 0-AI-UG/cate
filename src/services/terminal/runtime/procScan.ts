// Process scans behind terminal activity, ports and cwd. POSIX only: Linux
// reads /proc (no fork, #246), macOS runs ps and lsof. Windows reports nothing.

import { execFile } from 'node:child_process'
import type { TerminalActivity } from '../contract'
import { getCwdProc, listeningPortsByPidProc, snapshotProcessTreeProc, type ProcTree } from './procfs'

export type { ProcTree } from './procfs'

const isLinux = process.platform === 'linux'

/** One `ps` snapshot of the whole process table, indexed for tree walks. */
function snapshotProcessTreePs(): Promise<ProcTree> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,comm='], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ nameByPid: new Map(), childrenByPid: new Map() })
        return
      }
      resolve(parsePsTable(stdout))
    })
  })
}

/** Parses `ps -axo pid=,ppid=,comm=`. comm may hold spaces and is a full path
 *  on macOS, so the basename is kept. */
export function parsePsTable(stdout: string): ProcTree {
  const nameByPid = new Map<number, string>()
  const childrenByPid = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*\S)\s*$/)
    if (!m) continue
    const pid = parseInt(m[1], 10)
    const ppid = parseInt(m[2], 10)
    nameByPid.set(pid, m[3].split('/').pop() ?? m[3])
    const siblings = childrenByPid.get(ppid)
    if (siblings) siblings.push(pid)
    else childrenByPid.set(ppid, [pid])
  }
  return { nameByPid, childrenByPid }
}

export function snapshotProcessTree(): Promise<ProcTree> {
  if (process.platform === 'win32') return Promise.resolve({ nameByPid: new Map(), childrenByPid: new Map() })
  return isLinux ? snapshotProcessTreeProc() : snapshotProcessTreePs()
}

function cwdForPid(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return Promise.resolve(null)
  if (isLinux) return getCwdProc(pid)
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-p', `${pid}`, '-Fn'], { encoding: 'utf-8', timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const nameLine = stdout.split('\n').find((l) => l.startsWith('n'))
      resolve(nameLine ? nameLine.slice(1) : null)
    })
  })
}

/** Parses `lsof -Fn` output for several pids: `p<pid>` then `n<path>`. */
export function parseLsofCwds(stdout: string): Map<number, string> {
  const result = new Map<number, string>()
  let pid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = parseInt(line.slice(1), 10)
    else if (line.startsWith('n') && pid !== null && !result.has(pid)) result.set(pid, line.slice(1))
  }
  return result
}

/** The cwd of several pids: one lsof on macOS, /proc on Linux. */
async function cwdsForPids(pids: number[]): Promise<Map<number, string>> {
  const result = new Map<number, string>()
  if (pids.length === 0 || process.platform === 'win32') return result
  if (isLinux) {
    await Promise.all(pids.map(async (pid) => {
      const cwd = await getCwdProc(pid)
      if (cwd) result.set(pid, cwd)
    }))
    return result
  }
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'], { encoding: 'utf-8', timeout: 3000 }, (_err, stdout) => {
      // lsof exits 1 when a pid is gone but still prints the rest.
      resolve(typeof stdout === 'string' ? parseLsofCwds(stdout) : result)
    })
  })
}

/** All descendant pids of `pid`, excluding `pid`. */
export function descendantsOf(pid: number, tree: ProcTree): number[] {
  const out: number[] = []
  const stack = [...(tree.childrenByPid.get(pid) ?? [])]
  while (stack.length > 0) {
    const p = stack.pop()!
    out.push(p)
    const kids = tree.childrenByPid.get(p)
    if (kids) stack.push(...kids)
  }
  return out
}

const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'tcsh', 'ksh', 'dash'])

function isShellProcess(name: string): boolean {
  return SHELLS.has(name.toLowerCase())
}

/** The first non-shell direct child of the shell (a dev server, an editor, an
 *  agent CLI). Agent identity is not decided here: the agents service anchors
 *  it to the pid its hooks report. */
export function activityForPid(shellPid: number, tree: ProcTree): TerminalActivity {
  for (const childPid of tree.childrenByPid.get(shellPid) ?? []) {
    const name = tree.nameByPid.get(childPid)
    if (name && !isShellProcess(name)) return { type: 'running', processName: name }
  }
  return { type: 'idle' }
}

/** Listening TCP ports per root pid, over each root's whole process tree. */
async function listeningPorts(roots: number[], tree: ProcTree): Promise<Map<number, number[]>> {
  const result = new Map<number, number[]>()
  if (roots.length === 0 || process.platform === 'win32') return result
  const rootOf = new Map<number, number>()
  for (const root of roots) {
    rootOf.set(root, root)
    for (const child of descendantsOf(root, tree)) rootOf.set(child, root)
  }
  const add = (pid: number, port: number): void => {
    const root = rootOf.get(pid)
    if (root === undefined) return
    const ports = result.get(root) ?? []
    if (!ports.includes(port)) ports.push(port)
    result.set(root, ports)
  }
  const pids = [...rootOf.keys()]
  if (isLinux) {
    for (const [pid, ports] of await listeningPortsByPidProc(pids)) for (const port of ports) add(pid, port)
    return result
  }
  const stdout = await new Promise<string>((resolve) => {
    // `-a` ANDs the network filter with `-p`, so lsof looks only at these trees.
    execFile('lsof', ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-a', '-p', pids.join(','), '-F', 'pn'], { timeout: 5000 },
      // lsof exits 1 when some pids have no listeners but still prints the rest.
      (_err, out) => resolve(typeof out === 'string' ? out : ''))
  })
  let currentPid: number | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) currentPid = parseInt(line.slice(1), 10)
    else if (line.startsWith('n') && currentPid != null) {
      const match = line.match(/:(\d+)$/)
      if (match) add(currentPid, parseInt(match[1], 10))
    }
  }
  return result
}

export interface ProcessScanner {
  tree(): Promise<ProcTree>
  cwd(pid: number): Promise<string | null>
  /** Several pids in one scan; without it, `cwd` per pid. */
  cwds?(pids: number[]): Promise<Map<number, string>>
  ports(roots: number[], tree: ProcTree): Promise<Map<number, number[]>>
}

export const systemScanner: ProcessScanner = {
  tree: snapshotProcessTree,
  cwd: cwdForPid,
  cwds: cwdsForPids,
  ports: listeningPorts,
}

/** macOS scans run ps and lsof; Linux reads /proc; Windows does nothing. */
const SCANS_SPAWN = process.platform !== 'linux' && process.platform !== 'win32'

/** Counts the subprocesses a scanner's calls spawn (`spawnPs`, `spawnLsof`)
 *  for the runtime's perf counters. */
export function countingScanner(scanner: ProcessScanner, count: (name: string) => void, spawns = SCANS_SPAWN): ProcessScanner {
  const counted = (name: string) => { if (spawns) count(name) }
  return {
    tree: () => { counted('spawnPs'); return scanner.tree() },
    cwd: (pid) => { counted('spawnLsof'); return scanner.cwd(pid) },
    ...(scanner.cwds ? { cwds: (pids: number[]) => { if (pids.length) counted('spawnLsof'); return scanner.cwds!(pids) } } : {}),
    ports: (roots, tree) => { if (roots.length) counted('spawnLsof'); return scanner.ports(roots, tree) },
  }
}
