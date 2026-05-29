// =============================================================================
// PerfHud — live resource overlay, mounted only under CATE_PERF=1.
//
// Pulls the main-process snapshot (per-process CPU/mem, subprocess spawns, IPC
// bytes, terminal throughput) once a second and combines it with the renderer's
// own counters (FPS, long tasks, renders/sec). Toggle with Cmd/Ctrl+Alt+P.
//
// Read this while you pan, zoom, and watch an agent stream — the numbers tell
// you which of the audited hot paths is actually costing you on your machine.
// =============================================================================

import { useEffect, useRef, useState } from 'react'
import type { PerfSnapshot } from '../../shared/types'
import {
  PERF_ENABLED,
  getRenderCounts,
  getLongTasks,
  getFps,
  resetPerfWindow,
} from '../lib/perf/perfClient'

interface RenderRate { name: string; perSec: number }

/** Diff a cumulative counter map against the previous read → per-second rates. */
function diffRates(
  counts: Map<string, number>,
  prev: Map<string, number>,
  elapsedSec: number,
): RenderRate[] {
  const rates: RenderRate[] = []
  for (const [name, total] of counts) {
    const delta = total - (prev.get(name) ?? 0)
    prev.set(name, total)
    if (delta > 0) rates.push({ name, perSec: Math.round(delta / elapsedSec) })
  }
  return rates.sort((a, b) => b.perSec - a.perSec)
}

export default function PerfHud(): JSX.Element | null {
  const [visible, setVisible] = useState(true)
  const [snap, setSnap] = useState<PerfSnapshot | null>(null)
  const [fps, setFps] = useState(0)
  const [longTasks, setLongTasks] = useState({ count: 0, maxMs: 0 })
  const [renderRates, setRenderRates] = useState<RenderRate[]>([])

  const prevCounts = useRef<Map<string, number>>(new Map())
  const prevAt = useRef<number>(performance.now())

  useEffect(() => {
    if (!PERF_ENABLED) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && (e.metaKey || e.ctrlKey) && e.code === 'KeyP') {
        e.preventDefault()
        setVisible((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!PERF_ENABLED) return
    let alive = true
    const id = setInterval(async () => {
      const now = performance.now()
      const elapsedSec = Math.max(0.001, (now - prevAt.current) / 1000)
      prevAt.current = now

      // Renders/sec — diff cumulative counters against the previous read.
      const rates = diffRates(getRenderCounts(), prevCounts.current, elapsedSec)

      const lt = getLongTasks()
      if (alive) {
        setFps(getFps())
        setLongTasks(lt)
        setRenderRates(rates.slice(0, 8))
      }
      resetPerfWindow()

      try {
        const s = await window.electronAPI?.perfGetSnapshot?.()
        if (alive && s) setSnap(s)
      } catch { /* main not ready */ }
    }, 1000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!PERF_ENABLED) return null

  if (!visible) {
    return (
      <div
        className="fixed bottom-2 left-2 z-[10000] px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-emerald-300 pointer-events-none select-none"
      >
        perf ⌘⌥P
      </div>
    )
  }

  const fpsColor = fps >= 55 ? 'text-emerald-300' : fps >= 30 ? 'text-amber-300' : 'text-red-400'

  return (
    <div
      className="fixed bottom-2 left-2 z-[10000] w-[280px] max-h-[70vh] overflow-auto rounded-md bg-black/80 backdrop-blur-sm text-[10px] leading-tight font-mono text-zinc-200 p-2 pointer-events-auto select-text shadow-lg ring-1 ring-white/10"
    >
      <div className="flex items-center justify-between mb-1 text-zinc-400">
        <span className="font-semibold tracking-wide text-zinc-300">CATE PERF</span>
        <span>⌘⌥P to hide</span>
      </div>

      {/* Renderer */}
      <div className="flex gap-3 mb-1">
        <span className={fpsColor}>{fps} fps</span>
        <span className={longTasks.count > 0 ? 'text-amber-300' : 'text-zinc-400'}>
          longtasks {longTasks.count}{longTasks.maxMs ? ` (max ${Math.round(longTasks.maxMs)}ms)` : ''}
        </span>
      </div>

      {/* Main-process snapshot */}
      {snap ? (
        <>
          <div className="text-zinc-400 mt-1.5 border-t border-white/10 pt-1">
            main · cpu <span className="text-zinc-100">{snap.totalCpu}%</span> ·{' '}
            {snap.focused ? 'focused' : <span className="text-amber-300">backgrounded</span>}
          </div>
          {snap.procs.slice(0, 5).map((p) => (
            <div key={p.pid} className="flex justify-between text-zinc-300">
              <span className="truncate">{p.type}</span>
              <span className="text-zinc-400">{p.cpu}% · {p.memMB}MB</span>
            </div>
          ))}

          <div className="text-zinc-400 mt-1.5">terminal</div>
          <div className="text-zinc-300">{snap.terminal.kbPerSec} KB/s · {snap.terminal.chunksPerSec} chunks/s</div>

          {Object.keys(snap.spawnsPerSec).length > 0 && (
            <>
              <div className="text-zinc-400 mt-1.5">subprocess spawns/s</div>
              {Object.entries(snap.spawnsPerSec).map(([k, v]) => (
                <div key={k} className="flex justify-between text-zinc-300">
                  <span>{k}</span><span className={v > 2 ? 'text-amber-300' : 'text-zinc-400'}>{v}</span>
                </div>
              ))}
            </>
          )}

          {snap.ipc.length > 0 && (
            <>
              <div className="text-zinc-400 mt-1.5">ipc → renderer (top)</div>
              {snap.ipc.slice(0, 5).map((c) => (
                <div key={c.channel} className="flex justify-between text-zinc-300">
                  <span className="truncate mr-2">{c.channel}</span>
                  <span className="text-zinc-400 whitespace-nowrap">{c.kbPerSec}KB/s · {c.callsPerSec}/s</span>
                </div>
              ))}
            </>
          )}
        </>
      ) : (
        <div className="text-zinc-500 mt-1">sampling main process…</div>
      )}

      {/* Renderer render rates */}
      {renderRates.length > 0 && (
        <>
          <div className="text-zinc-400 mt-1.5 border-t border-white/10 pt-1">renders/s</div>
          {renderRates.map((r) => (
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
