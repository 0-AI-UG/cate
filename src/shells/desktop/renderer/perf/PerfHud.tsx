// The perf HUD: main's per-process CPU and memory, each open runtime's own
// sample, and this window's frames, long tasks and counters. It shows only
// when main runs with CATE_PERF=1 (main answers `app.perf()` with samples);
// Cmd/Ctrl+Alt+P hides it.

import { useEffect, useRef, useState } from 'react'
import type { RuntimePerfSample } from '@runtime/daemon/contract'
import type { WorkspaceConnections } from '@client/connections'
import type { AppPerfSnapshot, DesktopApi } from '../../contract'
import {
  enablePerf,
  getFps,
  getFrameTimes,
  getLongTasks,
  getRenderCounts,
  isLongTaskObserverSupported,
  perfEnabled,
  resetPerfWindow,
} from './perfClient'

/** Main samples every 2 s; a few empty answers mean perf is off. */
const PROBES = 5

interface Rate { name: string; perSec: number }
interface RuntimeRow { id: string; sample?: RuntimePerfSample; error?: string }

function diffRates(counts: Map<string, number>, prev: Map<string, number>, elapsedSec: number): Rate[] {
  const rates: Rate[] = []
  for (const [name, total] of counts) {
    const delta = total - (prev.get(name) ?? 0)
    prev.set(name, total)
    if (delta > 0) rates.push({ name, perSec: Math.round(delta / elapsedSec) })
  }
  return rates.sort((a, b) => b.perSec - a.perSec)
}

export function PerfHud({ api, connections }: { api: DesktopApi; connections: WorkspaceConnections }): JSX.Element | null {
  const [on, setOn] = useState(perfEnabled())
  const [visible, setVisible] = useState(true)
  const [snap, setSnap] = useState<AppPerfSnapshot | null>(null)
  const [runtimes, setRuntimes] = useState<RuntimeRow[]>([])
  const [fps, setFps] = useState(0)
  const [frames, setFrames] = useState({ p95Ms: 0, maxMs: 0 })
  const [longTasks, setLongTasks] = useState({ count: 0, maxMs: 0 })
  const [rates, setRates] = useState<Rate[]>([])
  const prevCounts = useRef(new Map<string, number>())
  const prevAt = useRef(performance.now())

  useEffect(() => {
    if (on) return
    let alive = true
    let probes = 0
    const probe = setInterval(() => {
      void api.app.perf().then((sample) => {
        if (!alive) return
        if (sample) {
          clearInterval(probe)
          enablePerf()
          setSnap(sample)
          setOn(true)
        } else if (++probes >= PROBES) {
          clearInterval(probe)
        }
      }, () => clearInterval(probe))
    }, 1000)
    return () => { alive = false; clearInterval(probe) }
  }, [api, on])

  useEffect(() => {
    if (!on) return
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && (e.metaKey || e.ctrlKey) && e.code === 'KeyP') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [on])

  useEffect(() => {
    if (!on) return
    let alive = true
    const id = setInterval(() => {
      const now = performance.now()
      const elapsedSec = Math.max(0.001, (now - prevAt.current) / 1000)
      prevAt.current = now
      setFps(getFps())
      setFrames(getFrameTimes())
      setLongTasks(getLongTasks())
      setRates(diffRates(getRenderCounts(), prevCounts.current, elapsedSec).slice(0, 8))
      resetPerfWindow()
      void api.app.perf().then((s) => { if (alive && s) setSnap(s) }, () => {})
      void Promise.all(connections.getSnapshot().map(async (connection): Promise<RuntimeRow> => {
        const id = connection.workspaceId
        if (connection.state.kind !== 'connected') return { id, error: connection.state.kind }
        try {
          return { id, sample: await connection.runtime.runtime.perf() }
        } catch (err) {
          return { id, error: err instanceof Error ? err.message : String(err) }
        }
      })).then((rows) => { if (alive) setRuntimes(rows) })
    }, 1000)
    return () => { alive = false; clearInterval(id) }
  }, [api, connections, on])

  if (!on) return null
  if (!visible) {
    return (
      <div className="fixed bottom-2 left-2 z-[10000] px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-emerald-300 pointer-events-none select-none">
        perf ⌘⌥P
      </div>
    )
  }

  const fpsColor = fps >= 55 ? 'text-emerald-300' : fps >= 30 ? 'text-amber-300' : 'text-red-400'
  return (
    <div className="fixed bottom-2 left-2 z-[10000] w-[280px] max-h-[70vh] overflow-auto rounded-md bg-black/80 backdrop-blur-sm text-[10px] leading-tight font-mono text-zinc-200 p-2 pointer-events-auto select-text shadow-lg ring-1 ring-white/10">
      <div className="flex items-center justify-between mb-1 text-zinc-400">
        <span className="font-semibold tracking-wide text-zinc-300">CATE PERF</span>
        <span>⌘⌥P to hide</span>
      </div>
      <div className="flex gap-3 mb-1">
        <span className={fpsColor}>{fps} fps</span>
        <span className={longTasks.count > 0 ? 'text-amber-300' : 'text-zinc-400'}>
          {isLongTaskObserverSupported() ? `longtasks ${longTasks.count}` : 'longtasks unavailable'}{longTasks.maxMs ? ` (max ${Math.round(longTasks.maxMs)}ms)` : ''}
        </span>
      </div>
      <div className="text-zinc-400">frame p95 {frames.p95Ms.toFixed(1)}ms · max {frames.maxMs.toFixed(1)}ms</div>
      {snap ? (
        <>
          <div className="text-zinc-400 mt-1.5 border-t border-subtle pt-1">
            Electron · cpu <span className="text-zinc-100">{snap.totalCpu}%</span> ·{' '}
            {snap.focused ? 'focused' : <span className="text-amber-300">backgrounded</span>}
          </div>
          {snap.procs.slice(0, 5).map((p) => (
            <div key={p.pid} className="flex justify-between text-zinc-300">
              <span className="truncate">{p.type}</span>
              <span className="text-zinc-400">{p.cpu}% · {p.memMB}MB</span>
            </div>
          ))}
        </>
      ) : (
        <div className="text-zinc-500 mt-1">sampling main process…</div>
      )}
      {runtimes.map(({ id, sample, error }) => (
        <div key={id} className="text-zinc-400 mt-1">
          {id}: {sample ? `${sample.cpu.toFixed(1)}% core · ${Math.round(sample.rssMB)}MB RSS · loop p95 ${sample.eventLoop.p95Ms.toFixed(1)}ms` : `unavailable (${error})`}
        </div>
      ))}
      {rates.length > 0 && (
        <>
          <div className="text-zinc-400 mt-1.5 border-t border-subtle pt-1">renders / work counters per second</div>
          {rates.map((r) => (
            <div key={r.name} className="flex justify-between text-zinc-300">
              <span className="truncate mr-2">{r.name}</span>
              <span className={r.perSec > 60 ? 'text-amber-300' : 'text-zinc-400'}>{r.perSec}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
