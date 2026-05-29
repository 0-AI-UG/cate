// =============================================================================
// perfMonitor — main-process resource profiler, gated entirely behind
// CATE_PERF=1 so it costs nothing on normal launches (mirrors CATE_E2E).
//
// It does two things on a fixed interval:
//   1. Samples app.getAppMetrics() for per-process CPU% + working-set memory.
//   2. Drains lightweight counters that instrument the hot paths the perf audit
//      flagged — subprocess spawns (pgrep/ps/lsof/git), main->renderer IPC bytes
//      per channel, and terminal PTY throughput.
//
// The latest snapshot is logged and stored; the renderer HUD pulls it over IPC
// (PERF_GET). Counters are runtime no-ops unless PERF_ENABLED, and the byte-size
// accounting at call sites is additionally gated on PERF_ENABLED so disabled
// builds never even compute payload sizes.
//
// Enable with:  CATE_PERF=1 npm run dev
// =============================================================================

import { app, BrowserWindow } from 'electron'
import log from '../logger'
import type { PerfProcSample, PerfSnapshot } from '../../shared/types'

export const PERF_ENABLED = process.env.CATE_PERF === '1'

const SAMPLE_INTERVAL_MS = 2000

// --- Counters (reset every sample tick) -------------------------------------
const spawnCounts = new Map<string, number>()
const ipcByChannel = new Map<string, { bytes: number; count: number }>()
let terminalBytes = 0
let terminalChunks = 0

/** Count a subprocess spawn, labelled by command (e.g. 'pgrep', 'git'). */
export function countSpawn(label: string): void {
  if (!PERF_ENABLED) return
  spawnCounts.set(label, (spawnCounts.get(label) ?? 0) + 1)
}

/** Count a main->renderer IPC send. `bytes` is an approximate payload size. */
export function countIpc(channel: string, bytes: number): void {
  if (!PERF_ENABLED) return
  const e = ipcByChannel.get(channel)
  if (e) { e.bytes += bytes; e.count++ }
  else ipcByChannel.set(channel, { bytes, count: 1 })
}

/** Count one chunk of PTY output forwarded toward the renderer. */
export function countTerminalData(bytes: number): void {
  if (!PERF_ENABLED) return
  terminalBytes += bytes
  terminalChunks++
}

// --- Snapshot ----------------------------------------------------------------
let latest: PerfSnapshot | null = null
let timer: ReturnType<typeof setInterval> | null = null

export function getLatestSnapshot(): PerfSnapshot | null {
  return latest
}

function tick(): void {
  const secs = SAMPLE_INTERVAL_MS / 1000
  const focused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())

  let totalCpu = 0
  const procs: PerfProcSample[] = app.getAppMetrics().map((m) => {
    const cpu = Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10
    totalCpu += cpu
    return {
      type: m.type,
      pid: m.pid,
      cpu,
      // workingSetSize is reported in kilobytes.
      memMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
    }
  })
  totalCpu = Math.round(totalCpu * 10) / 10

  const spawnsPerSec: Record<string, number> = {}
  for (const [label, n] of spawnCounts) spawnsPerSec[label] = Math.round((n / secs) * 10) / 10

  const ipc = Array.from(ipcByChannel.entries())
    .map(([channel, e]) => ({
      channel,
      kbPerSec: Math.round((e.bytes / secs / 1024) * 10) / 10,
      callsPerSec: Math.round((e.count / secs) * 10) / 10,
    }))
    .sort((a, b) => b.kbPerSec - a.kbPerSec)

  latest = {
    windowMs: SAMPLE_INTERVAL_MS,
    focused,
    totalCpu,
    procs: procs.sort((a, b) => b.cpu - a.cpu),
    spawnsPerSec,
    ipc,
    terminal: {
      kbPerSec: Math.round((terminalBytes / secs / 1024) * 10) / 10,
      chunksPerSec: Math.round((terminalChunks / secs) * 10) / 10,
    },
  }

  // Compact one-line log so it's greppable in the terminal running `npm run dev`.
  const topIpc = ipc.slice(0, 3).map((c) => `${c.channel}=${c.kbPerSec}KB/s`).join(' ')
  const spawnStr = Object.entries(spawnsPerSec).map(([k, v]) => `${k}=${v}/s`).join(' ')
  log.info(
    '[perf] cpu=%s%% focused=%s term=%sKB/s(%s chunks/s) spawns[%s] ipc[%s]',
    totalCpu, focused, latest.terminal.kbPerSec, latest.terminal.chunksPerSec, spawnStr, topIpc,
  )

  spawnCounts.clear()
  ipcByChannel.clear()
  terminalBytes = 0
  terminalChunks = 0
}

export function startPerfMonitor(): void {
  if (!PERF_ENABLED || timer) return
  log.info('[perf] CATE_PERF=1 — resource profiler active (sampling every %dms)', SAMPLE_INTERVAL_MS)
  timer = setInterval(tick, SAMPLE_INTERVAL_MS)
  // Don't keep the event loop alive solely for profiling.
  if (typeof timer.unref === 'function') timer.unref()
}

export function stopPerfMonitor(): void {
  if (timer) { clearInterval(timer); timer = null }
}
