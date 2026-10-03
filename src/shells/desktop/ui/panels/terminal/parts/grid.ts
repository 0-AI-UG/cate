// The terminal view's grid. The xterm always has the PTY's grid, which fits
// whichever viewer last asked (`fit`, services/terminal). The view reports the
// grid its panel holds (the runtime resizes the PTY to it while the PTY fits
// this view) and, when the PTY's grid is not the panel's, the render box takes
// the grid's size, scaled down to the panel when it is bigger.

import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BindTerminalOptions, TerminalBinding } from '@services/terminal/client'
import type { TerminalXterm } from './xterm'

export type Grid = { cols: number; rows: number }
type Box = { width: number; height: number }

/** The render box when it holds the PTY's grid instead of filling the panel:
 *  its size (render box coordinates) and the scale that fits it in. */
export type GridLayout = Box & { scale: number }

const REPORT_DEBOUNCE_MS = 32

export const sameGrid = (a: Grid | null, b: Grid | null) => a?.cols === b?.cols && a?.rows === b?.rows

/** The PTY's grid box in a panel box: scaled down when it is bigger. */
export function gridLayoutFor(grid: Box, panel: Box): GridLayout {
  return { ...grid, scale: Math.min(1, panel.width / grid.width, panel.height / grid.height) }
}

/** Gives the xterm a grid, staying at the bottom when it was there. */
function resizeXterm(xterm: TerminalXterm, grid: Grid): void {
  if (grid.cols === xterm.terminal.cols && grid.rows === xterm.terminal.rows) return
  const atBottom = xterm.isAtBottom()
  xterm.terminal.resize(grid.cols, grid.rows)
  if (atBottom) xterm.terminal.scrollToBottom()
}

export interface TerminalGridDeps {
  ready: boolean
  /** The panel area the render box sits in. */
  container: RefObject<HTMLElement | null>
  xterm: RefObject<TerminalXterm | null>
  binding: RefObject<TerminalBinding | null>
  /** The render box's counter-scale on a zoomed canvas (its coordinates are
   *  the panel's times this). */
  cellScale: { w: number; h: number }
  /** Wait while this holds (a canvas gesture resizing every tick). */
  busy(): boolean
  /** Changes when the font does. */
  font: unknown
}

export interface TerminalGrid {
  /** What `bindTerminal` needs: the panel's grid and the PTY's. */
  bindingOptions(xterm: TerminalXterm): Pick<BindTerminalOptions, 'size' | 'onSize'>
  /** Null while the render box fills the panel. */
  layout: GridLayout | null
  /** The PTY's grid, when the PTY fits another view and not this panel's grid. */
  elsewhere: Grid | null
}

export function useTerminalGrid(deps: TerminalGridDeps): TerminalGrid {
  const { ready, container, xterm, binding, cellScale, busy, font } = deps
  const [panel, setPanel] = useState<Grid | null>(null)
  const panelRef = useRef<Grid | null>(null)
  const [pty, setPty] = useState<Grid | null>(null)
  const [fitted, setFitted] = useState(false)
  const fittedRef = useRef(false)
  const cellScaleRef = useRef(cellScale)
  cellScaleRef.current = cellScale
  const busyRef = useRef(busy)
  busyRef.current = busy

  /** The grid the panel holds, in render box coordinates. */
  const measure = (): Grid | null => {
    const box = container.current
    const scale = cellScaleRef.current
    if (!box || !xterm.current) return null
    return xterm.current.gridFor({ width: box.clientWidth * scale.w, height: box.clientHeight * scale.h })
  }

  // Report the panel's grid when it changes; while the PTY fits this view,
  // take it at once rather than a round trip later.
  const scheduleRef = useRef<() => void>(() => {})
  useEffect(() => {
    const box = container.current
    if (!ready || !box || typeof ResizeObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = () => {
      timer = null
      if (busyRef.current()) {
        timer = setTimeout(run, REPORT_DEBOUNCE_MS)
        return
      }
      const next = measure()
      if (!next || sameGrid(next, panelRef.current)) return
      panelRef.current = next
      setPanel(next)
      if (fittedRef.current && xterm.current) resizeXterm(xterm.current, next)
      binding.current?.resized()
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, REPORT_DEBOUNCE_MS)
    }
    scheduleRef.current = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(box)
    schedule()
    return () => {
      scheduleRef.current = () => {}
      observer.disconnect()
      if (timer) clearTimeout(timer)
    }
    // `measure` reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Another cell size changes the grid the panel holds.
  useEffect(() => { scheduleRef.current() }, [cellScale, font])

  const elsewhere = pty && !fitted && !sameGrid(pty, panel) ? pty : null
  const [layout, setLayout] = useState<GridLayout | null>(null)
  useEffect(() => {
    const box = container.current
    const gridBox = xterm.current?.gridBox()
    if (!ready || !box || !gridBox || !elsewhere) {
      setLayout(null)
      return
    }
    setLayout(gridLayoutFor(gridBox, { width: box.clientWidth * cellScale.w, height: box.clientHeight * cellScale.h }))
    // `elsewhere` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pty, panel, fitted, cellScale, font])

  return {
    bindingOptions: (term) => ({
      size: () => panelRef.current ?? measure() ?? { cols: term.terminal.cols, rows: term.terminal.rows },
      // Before the screen is written, so it lands on the PTY's grid.
      onSize: ({ cols, rows, fitted: next }) => {
        resizeXterm(term, { cols, rows })
        fittedRef.current = next
        setPty({ cols, rows })
        setFitted(next)
      },
    }),
    layout,
    elsewhere,
  }
}
