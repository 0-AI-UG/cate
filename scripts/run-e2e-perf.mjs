import { execFile, spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const playwright = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js')
const defaultSpecs = [
  'e2e/startup-performance.spec.ts',
  'e2e/panel-creation-performance.spec.ts',
  'e2e/canvas-scale-perf.spec.ts',
  'e2e/workspace-transition-perf.spec.ts',
  'e2e/worktree-territory-perf.spec.ts',
  'e2e/browser-performance.spec.ts',
  // This suite leaves the largest Chromium process tree, so run it last.
  'e2e/perf-stress.spec.ts',
]
const specs = process.argv.slice(2).length ? process.argv.slice(2) : defaultSpecs
const maxRamMB = Number(process.env.CATE_E2E_MAX_RAM_MB ?? 6144)

if (!Number.isFinite(maxRamMB) || maxRamMB <= 0) {
  throw new Error('CATE_E2E_MAX_RAM_MB must be a positive number')
}

function processTable() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'win32') {
      const command = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'
      execFile('powershell.exe', ['-NoProfile', '-Command', command], (error, stdout) => {
        if (error) return reject(error)
        const parsed = JSON.parse(stdout || '[]')
        const rows = Array.isArray(parsed) ? parsed : [parsed]
        resolve(rows.map((row) => ({
          pid: Number(row.ProcessId),
          ppid: Number(row.ParentProcessId),
          rssKB: Math.round(Number(row.WorkingSetSize) / 1024),
        })))
      })
      return
    }
    execFile('ps', ['-axo', 'pid=,ppid=,rss='], (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout.trim().split('\n').flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/)
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssKB: Number(match[3]) }] : []
      }))
    })
  })
}

async function descendantRssKB(rootPid) {
  const rows = await processTable()
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return rows.reduce((sum, row) => sum + (descendants.has(row.pid) ? row.rssKB : 0), 0)
}

function terminate(child, signal = 'SIGTERM') {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref()
    else process.kill(-child.pid, signal)
  } catch { /* process already exited */ }
}

async function runSpec(spec) {
  const uncapped = /(?:^|[-_.])(memory|ram)(?:[-_.]|$)/i.test(path.basename(spec))
  console.log(`\n[perf] ${spec} · workers=1 · RAM ${uncapped ? 'uncapped' : `cap=${maxRamMB} MB`}`)
  const child = spawn(process.execPath, [playwright, 'test', spec, '--workers=1'], {
    cwd: root,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: 'inherit',
  })
  let peakKB = 0
  let exceeded = false
  let sampling = false
  const timer = uncapped ? undefined : setInterval(async () => {
    if (sampling || child.exitCode !== null) return
    sampling = true
    try {
      const rssKB = await descendantRssKB(child.pid)
      peakKB = Math.max(peakKB, rssKB)
      if (rssKB > maxRamMB * 1024) {
        exceeded = true
        console.error(`[perf] RAM cap exceeded: ${Math.round(rssKB / 1024)} MB > ${maxRamMB} MB`)
        terminate(child)
        setTimeout(() => terminate(child, 'SIGKILL'), 5_000).unref()
      }
    } catch (error) {
      exceeded = true
      console.error(`[perf] RAM watchdog failed: ${error instanceof Error ? error.message : String(error)}`)
      terminate(child)
    } finally {
      sampling = false
    }
  }, 1_000)

  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)))
  })
  if (timer) clearInterval(timer)
  if (!uncapped) {
    console.log(`[perf] peak descendant RSS: ${Math.round(peakKB / 1024)} MB / ${maxRamMB} MB`)
  }
  if (exceeded) return 137
  return code
}

for (const spec of specs) {
  const code = await runSpec(spec)
  if (code !== 0) process.exit(code)
}
