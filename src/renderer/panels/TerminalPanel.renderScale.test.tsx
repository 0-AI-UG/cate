// Regression: a terminal panel mounted while the canvas is ALREADY zoomed in.
//
// getOrCreate is async, so the render-scale effect can run before attach() has
// opened xterm into the render box. At that point terminal.element is undefined
// and there is nothing to measure — but the effect still wanted to raise
// fontSize to base × renderScale. That grows the cell while cellScale stays at
// 1, which is exactly the box/cell mismatch the effect exists to prevent, and
// nothing recomputes it: renderScale has already settled at its target, so the
// effect never runs again on its own and the grid stays shrunk.
//
// Contract: the font is only ever bumped together with a matching measurement,
// and attach() re-triggers that measurement.

// @vitest-environment jsdom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom performs no layout, so the effect's "is this panel actually visible"
// guards (offsetParent, getBoundingClientRect) would bail before measuring
// anything. Give them plausible non-zero answers.
vi.hoisted(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get() { return document.body },
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: () => null,
  })
})
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  // ResizeObserver drives the plain-fit path; the panel only needs it to exist.
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  }
})

// Hoisted because vi.mock factories are lifted above this file's const
// declarations and reference these.
const h = vi.hoisted(() => {
  const BASE_FONT = 13
  // Deliberately fractional, like a real glyph advance. With whole numbers the
  // DPR 1 and DPR 2 rounding grids would coincide and the DPR test below could
  // not distinguish a stale baseline from a fresh one.
  const BASE_CELL_W = 7.3
  const BASE_CELL_H = 15.4
  return {
    BASE_FONT,
    BASE_CELL_W,
    BASE_CELL_H,
    // xterm rounds the cell to DEVICE pixels and reports CSS pixels back:
    // css.cell = round(char × dpr) / dpr. So the rounding grid is 1/dpr — whole
    // pixels at DPR 1, half pixels at DPR 2 — and the same font measures
    // differently per display. Model that; it is the whole reason a baseline is
    // only valid for the DPR it was taken at.
    cellW: (fontSize: number, dpr = window.devicePixelRatio) =>
      Math.round(((fontSize * BASE_CELL_W) / BASE_FONT) * dpr) / dpr,
    cellH: (fontSize: number, dpr = window.devicePixelRatio) =>
      Math.round(((fontSize * BASE_CELL_H) / BASE_FONT) * dpr) / dpr,
    fake: {
      cols: 80,
      rows: 24,
      options: { fontSize: BASE_FONT },
      element: null as HTMLElement | null,
    },
    // Resolved by the test to simulate a slow getOrCreate.
    releaseCreate: null as null | (() => void),
    attachCalls: 0,
    renderedDpr: null as number | null,
  }
})
const { BASE_FONT, cellW } = h

vi.mock('../lib/terminal/terminalRegistry', () => {
  const entry = { terminal: h.fake, ptyId: 'pty-1', workspaceId: 'ws-1' }
  return {
    terminalRegistry: {
      getOrCreate: vi.fn(
        () => new Promise((resolve) => { h.releaseCreate = () => resolve(entry) }),
      ),
      // attach() is what gives xterm a DOM element in the real code.
      attach: vi.fn(() => {
        h.attachCalls++
        const el = document.createElement('div')
        const screen = document.createElement('div')
        screen.className = 'xterm-screen'
        // jsdom does no layout: derive the box from the current font, the way a
        // real xterm would after re-rasterizing its atlas.
        Object.defineProperty(screen, 'offsetWidth', {
          get: () => h.fake.cols * h.cellW(
            h.fake.options.fontSize,
            h.renderedDpr ?? window.devicePixelRatio,
          ),
        })
        Object.defineProperty(screen, 'offsetHeight', {
          get: () => h.fake.rows * h.cellH(
            h.fake.options.fontSize,
            h.renderedDpr ?? window.devicePixelRatio,
          ),
        })
        const viewport = document.createElement('div')
        viewport.className = 'xterm-viewport'
        el.append(screen, viewport)
        h.fake.element = el
      }),
      detach: vi.fn(),
      getEntry: vi.fn(() => (h.fake.element || h.releaseCreate ? { terminal: h.fake } : null)),
      getFailure: vi.fn(() => null),
      subscribeFailure: vi.fn(() => () => {}),
      fit: vi.fn(),
      syncScrollBarWidth: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearSearch: vi.fn(),
      focus: vi.fn(),
      write: vi.fn(),
      isAlive: vi.fn(() => true),
    },
  }
})

// --- collaborators the panel pulls in but that are irrelevant here ----------

const canvasState = { zoomLevel: 2.0 }
vi.mock('../stores/CanvasStoreContext', () => ({
  useOptionalCanvasStoreApi: () => null,
  // Selectors that read state this fake doesn't model fall back, as they do
  // when the panel lives outside a canvas.
  useOptionalCanvasStoreContext: (sel: (s: unknown) => unknown, fallback: unknown) => {
    try {
      const v = sel(canvasState)
      return v === undefined ? fallback : v
    } catch {
      return fallback
    }
  },
}))
vi.mock('../stores/appStore', () => ({
  useAppStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ workspaces: [], retryRuntime: () => {} }),
    { getState: () => ({ workspaces: [], retryRuntime: () => {} }) },
  ),
}))
vi.mock('../stores/settingsStore', () => {
  const state = { terminalFontSize: h.BASE_FONT, terminalFontFamily: '' }
  return {
    useSettingsStore: Object.assign(
      (sel: (s: unknown) => unknown) => sel(state),
      { getState: () => state, subscribe: () => () => {} },
    ),
  }
})
vi.mock('../stores/uiStore', () => ({
  useUIStore: Object.assign((sel: (s: unknown) => unknown) => sel({}), { getState: () => ({}) }),
}))
vi.mock('../lib/activePanel', () => ({
  useActivePanelStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ activePanelId: null }),
    { getState: () => ({ activePanelId: null }), subscribe: () => () => {} },
  ),
  getActivePanelId: () => null,
  setActivePanel: () => {},
}))
vi.mock('./panelChrome', () => ({ useClaimPanelCorner: () => null }))
vi.mock('../hooks/useMissingAgentHookNotice', () => ({ useMissingAgentHookNotice: () => null }))
vi.mock('../lib/logger', () => ({
  default: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
}))

import TerminalPanel from './TerminalPanel'

// jsdom has no display model: drive devicePixelRatio directly and fire the
// resolution media query the panel arms, the way a real display change would.
const dprListeners = new Set<() => void>()
const setDpr = (dpr: number) => {
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: dpr })
}
const moveToDisplay = (dpr: number) => {
  setDpr(dpr)
  for (const fn of [...dprListeners]) fn()
}
window.matchMedia = ((q: string) => ({
  media: q,
  matches: true,
  addEventListener: (_: string, fn: () => void) => { dprListeners.add(fn) },
  removeEventListener: (_: string, fn: () => void) => { dprListeners.delete(fn) },
  addListener: () => {},
  removeListener: () => {},
  onchange: null,
  dispatchEvent: () => false,
})) as unknown as typeof window.matchMedia

describe('render scale on a panel mounted while already zoomed', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    h.fake.options.fontSize = BASE_FONT
    h.fake.element = null
    h.releaseCreate = null
    h.attachCalls = 0
    h.renderedDpr = null
    canvasState.zoomLevel = 2.0
    setDpr(1)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllTimers()
  })

  const renderPanel = async () => {
    await act(async () => {
      root.render(
        <TerminalPanel panelId="p1" workspaceId="ws-1" nodeId="n1" />,
      )
    })
  }
  // The render box carries the counter-scale as a width percentage.
  const renderBoxWidth = () =>
    (container.querySelector('[data-terminal-render-box]') as HTMLElement | null)?.style.width

  // The render-scale effect commits a new scale after 2 idle frames (so a
  // continuous pinch rebuilds the atlas only once).
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(undefined)))
  const flushFrames = async () => {
    await act(async () => { await nextFrame(); await nextFrame(); await nextFrame() })
  }

  it('does not raise the font while xterm is still unattached', async () => {
    await renderPanel()
    // Let renderScale settle at 2.0 with the spawn STILL in flight. This is the
    // race: the scale is now at its target and will not change again, so if the
    // font were raised here nothing would ever measure the matching cellScale.
    await flushFrames()

    expect(h.fake.element).toBeNull()
    expect(h.fake.options.fontSize).toBe(BASE_FONT)
  })

  it('measures and scales once attach provides an element', async () => {
    await renderPanel()
    await flushFrames() // renderScale reaches 2.0 before xterm exists

    await act(async () => {
      h.releaseCreate!()
      await Promise.resolve()
    })
    await flushFrames()

    expect(h.attachCalls).toBeGreaterThan(0)
    // Font raised to base × renderScale, now that there is something to measure.
    expect(h.fake.options.fontSize).toBe(BASE_FONT * 2)

    // And the box grew to match the MEASURED cell, not the intended ratio.
    expect(renderBoxWidth()).toBe(`${(cellW(BASE_FONT * 2) / cellW(BASE_FONT)) * 100}%`)
  })

  // Moving the window to a display with a different pixel density re-rounds
  // every cell (the grid is 1/dpr). A baseline captured on the old screen is
  // wrong on the new one, and nothing else would notice: the render box keeps
  // its CSS size so the ResizeObserver stays quiet, and renderScale is already
  // at its target so the measuring effect has no reason to re-run. The grid
  // would stay wrong until the user happened to zoom or resize by hand.
  it('re-derives the baseline when the window changes display density', async () => {
    await renderPanel()
    await flushFrames()
    await act(async () => {
      h.releaseCreate!()
      await Promise.resolve()
    })
    await flushFrames()

    const atDpr1 = renderBoxWidth()
    expect(atDpr1).toBe(`${(cellW(BASE_FONT * 2, 1) / cellW(BASE_FONT, 1)) * 100}%`)

    await act(async () => { moveToDisplay(2) })
    await flushFrames()

    // At DPR 2 the cell rounds on a half-pixel grid, so both the baseline and
    // the scaled cell differ from their DPR 1 values. The box must follow the
    // NEW pair — reusing the stale DPR 1 baseline leaves it at the old width.
    const base2 = cellW(BASE_FONT, 2)
    const scaled2 = cellW(BASE_FONT * 2, 2)
    expect(renderBoxWidth()).toBe(`${(scaled2 / base2) * 100}%`)
  })

  it('does not cache old geometry if DPR changes at render scale 1', async () => {
    h.renderedDpr = 1
    canvasState.zoomLevel = 1
    await renderPanel()
    await act(async () => {
      h.releaseCreate!()
      await Promise.resolve()
    })
    await flushFrames()

    // TerminalPanel's media-query callback runs first. At scale 1 it writes the
    // same font size, so xterm's option setter would not force a fresh measure.
    await act(async () => { moveToDisplay(2) })

    // xterm's own MediaQueryList listener runs after Cate's callback but before
    // the next animation frame, updating the terminal's geometry.
    h.renderedDpr = 2
    await flushFrames()

    canvasState.zoomLevel = 2
    await act(async () => {
      root.render(<TerminalPanel panelId="p1" workspaceId="ws-1" nodeId="n1" />)
    })
    await flushFrames()

    const base2 = cellW(BASE_FONT, 2)
    const scaled2 = cellW(BASE_FONT * 2, 2)
    expect(renderBoxWidth()).toBe(`${(scaled2 / base2) * 100}%`)
  })
})
