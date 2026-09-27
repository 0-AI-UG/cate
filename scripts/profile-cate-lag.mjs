// Read-only macOS diagnostics for a slowdown that can take days to develop.
// node scripts/profile-cate-lag.mjs [output-directory] [--once] [--capture]
// SIGUSR2 requests a stack capture; SIGTERM stops the monitor. No app restart,
// inspector port, terminal contents, environment, or command arguments are read.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const exec = promisify(execFile)
const directory = path.resolve(process.argv.slice(2).find(arg => !arg.startsWith('--'))
  ?? path.join(os.tmpdir(), `cate-lag-${Date.now()}`))
mkdirSync(directory, { recursive: true, mode: 0o700 })
const started = Date.now()
const deadline = started + 7 * 24 * 60 * 60 * 1000
const once = process.argv.includes('--once')
let requested = process.argv.includes('--capture')
let busy = false
let captures = 0
let lastCapture = 0
const renderers = new Map()
const log = (entry) => appendFileSync(path.join(directory, 'resources.jsonl'),
  JSON.stringify({ time: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 })
writeFileSync(path.join(directory, 'monitor.json'), JSON.stringify({
  pid: process.pid, started: new Date(started), deadline: new Date(deadline), intervalSeconds: 30,
}, null, 2), { mode: 0o600 })

async function poll() {
  if (busy) return
  if (Date.now() >= deadline) { stop(); return }
  busy = true
  try {
    const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,etime=,comm='], {
      timeout: 5000, maxBuffer: 4 * 1024 * 1024,
    })
    const rows = stdout.split('\n').flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/)
      return match ? [{ pid: +match[1], parent: +match[2], cpu: +match[3],
        rssMB: +match[4] / 1024, uptime: match[5], executable: match[6] }] : []
    })
    const roots = rows.filter(row => row.executable === '/Applications/Cate.app/Contents/MacOS/Cate')
    const owned = new Set(roots.map(row => row.pid))
    let previous = -1
    while (previous !== owned.size) {
      previous = owned.size
      for (const row of rows) if (owned.has(row.parent)) owned.add(row.pid)
    }
    const processes = rows.filter(row => owned.has(row.pid))
    const candidates = processes.filter(row => row.executable.includes('Cate Helper (Renderer).app/'))
    for (const pid of renderers.keys()) if (!candidates.some(row => row.pid === pid)) renderers.delete(pid)
    let trigger
    for (const row of candidates) {
      const state = renderers.get(row.pid) ?? { baselineMB: row.rssMB, hot: 0 }
      state.hot = row.cpu >= 70 ? state.hot + 1 : 0
      renderers.set(row.pid, state)
      if (state.hot >= 2 || row.rssMB - state.baselineMB >= 384) trigger = row
    }
    log({ kind: 'resources', loadAverage: os.loadavg(), freeMB: os.freemem() / 1024 ** 2,
      // RSS includes shared pages; summing these rows is not physical RAM use.
      processes: processes.map(row => ({ ...row, executable: path.basename(row.executable) })),
      windowServer: rows.find(row => row.executable.endsWith('/WindowServer'))?.cpu ?? null,
    })
    if (requested) trigger = candidates.sort((a, b) => b.cpu - a.cpu)[0]
    if (trigger && captures < 16 && (requested || Date.now() - lastCapture > 30 * 60_000)) {
      const reason = requested ? 'requested' : 'CPU >=70% twice or RSS growth >=384 MB'
      requested = false
      lastCapture = Date.now()
      const file = path.join(directory, `renderer-${trigger.pid}-${++captures}.sample.txt`)
      await exec('/usr/bin/sample', [String(trigger.pid), '5', '-file', file], { timeout: 20_000 })
      log({ kind: 'capture', pid: trigger.pid, reason, file })
    }
  } catch (error) {
    log({ kind: 'error', message: error.message })
  } finally {
    busy = false
    if (once) stop()
  }
}

let timer
function stop() {
  clearInterval(timer)
  log({ kind: 'stopped', captures })
  process.exitCode = 0
}
process.on('SIGUSR2', () => { requested = true; void poll() })
process.on('SIGTERM', () => { stop(); process.exit(0) })
process.on('SIGINT', () => { stop(); process.exit(0) })
log({ kind: 'started', monitorPid: process.pid })
if (!once) timer = setInterval(() => { void poll() }, 30_000)
await poll()
