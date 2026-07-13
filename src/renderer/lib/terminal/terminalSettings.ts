// =============================================================================
// terminalSettings — read/clamp terminal preferences, apply live setting changes
// to every running terminal, and own the theme / settings / window-focus
// subscriptions. The module-load subscriptions here are kept alive by the
// terminalRegistry barrel importing this module for its side effects.
// =============================================================================

import { useSettingsStore } from '../../stores/settingsStore'
import { subscribeTheme } from '../themeManager'
import type { Theme } from '../../../shared/types'
import { registry } from './registryState'
import { forceWebglRepaint } from './terminalDom'

export const DEFAULT_TERMINAL_FONT_FAMILY = 'Menlo, Monaco, "Courier New", monospace'
export const DEFAULT_TERMINAL_FONT_SIZE = 13

/** Read the configured terminal font family, falling back to xterm defaults. */
export function getTerminalFontFamily(): string {
  return resolveTerminalFontFamily(useSettingsStore.getState().terminalFontFamily)
}

export function resolveTerminalFontFamily(raw: string): string {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value || DEFAULT_TERMINAL_FONT_FAMILY
}

/** Read the base xterm font size before canvas zoom render scaling is applied. */
export function getTerminalBaseFontSize(): number {
  return resolveTerminalFontSize(useSettingsStore.getState().terminalFontSize)
}

export function resolveTerminalFontSize(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TERMINAL_FONT_SIZE
  return Math.max(1, Math.min(raw, 32))
}

/** Read the configured scrollback limit, clamped to a sane range. */
export function getScrollback(): number {
  const raw = useSettingsStore.getState().terminalScrollback
  if (!Number.isFinite(raw) || raw <= 0) return 2000
  return Math.max(100, Math.min(raw, 10000))
}

/** Clamp a raw terminalScrollSpeed multiplier (xterm `scrollSensitivity`) to the
 *  slider range. Invalid / non-positive values fall back to the xterm default. */
export function clampScrollSensitivity(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1.0
  return Math.max(0.25, Math.min(raw, 3.0))
}

/** Read the configured terminal scroll-speed multiplier (xterm `scrollSensitivity`). */
export function getScrollSensitivity(): number {
  return clampScrollSensitivity(useSettingsStore.getState().terminalScrollSpeed)
}

/** Clamp a raw terminalContrast value to xterm's valid `minimumContrastRatio`
 *  range (1 = off … 21). Invalid / non-positive values fall back to the WCAG-AA
 *  default. xterm re-clamps internally; this keeps our own reads sane too. */
export function clampContrastRatio(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 4.5
  return Math.max(1, Math.min(raw, 21))
}

/** Read the configured minimum text-contrast ratio (xterm `minimumContrastRatio`). */
export function getContrastRatio(): number {
  return clampContrastRatio(useSettingsStore.getState().terminalContrast)
}

function getCursorBlink(): boolean {
  return useSettingsStore.getState().terminalCursorBlink === true
}

/** Read whether ⌥ Option acts as Meta in the terminal (xterm macOptionIsMeta).
 *  Defaults to true (preserve historical behavior) when unset. */
export function getOptionIsMeta(): boolean {
  return useSettingsStore.getState().terminalOptionIsMeta !== false
}

// Track OS-window focus so we can pause cursor blinking while this window is
// not frontmost. A blinking cursor forces a GPU draw + WindowServer composite
// on every blink; xterm keeps blinking the focused terminal even when the app
// is backgrounded-but-visible, so we gate on the window 'blur'/'focus' events
// (not visibilitychange — a backgrounded window is still "visible" and painting).
let windowFocused = typeof document !== 'undefined' ? document.hasFocus() : true

/** Effective blink state = user setting AND this window is frontmost. */
export function effectiveCursorBlink(): boolean {
  return getCursorBlink() && windowFocused
}

/** Apply the active theme's terminal palette to every live terminal. Called
 *  whenever the unified theme changes. */
export function repaintAllTerminals(theme: Theme): void {
  for (const entry of registry.values()) {
    entry.terminal.options.theme = theme.terminal
  }
  // theme.terminal is baked into the SHARED WebGL glyph atlas (foreground/
  // background colors are rasterized into each cached glyph). Setting
  // options.theme per terminal re-lays-out that shared atlas but only redraws
  // the terminal whose option changed, leaving every sibling's render model
  // pointing at stale texture coordinates (scrambled glyphs). Resync all in one
  // coordinated pass — see forceWebglRepaint.
  forceWebglRepaint()
}

/** Apply a cursor-blink state to every live terminal. */
export function applyCursorBlinkToAll(blink: boolean): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.cursorBlink = blink
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
}

/** Apply terminal font settings to every live terminal. */
export function applyFontSettingsToAll(fontFamily: string, fontSize: number): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.fontFamily = fontFamily
      entry.terminal.options.fontSize = fontSize
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
  // Font family/size are part of the shared glyph-atlas key, so changing them
  // re-rasterizes the atlas and desyncs sibling terminals' render models. Resync
  // all in one coordinated pass — see repaintAllTerminals / forceWebglRepaint.
  forceWebglRepaint()
}

/** Apply a scroll-speed multiplier (xterm `scrollSensitivity`) to every live terminal. */
export function applyScrollSensitivityToAll(value: number): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.scrollSensitivity = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
}

/** Apply a minimum text-contrast ratio (xterm `minimumContrastRatio`) to every
 *  live terminal. Contrast-adjusted colors are baked into the cached glyphs, so
 *  this value is part of the shared glyph-atlas key: changing it re-rasterizes
 *  the atlas per terminal and desyncs siblings' render models exactly like a
 *  theme/font change. Resync all in one coordinated pass afterward. */
export function applyContrastRatioToAll(value: number): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.minimumContrastRatio = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
  forceWebglRepaint()
}

/** Apply the ⌥ Option-as-Meta setting (xterm `macOptionIsMeta`) to every live terminal. */
export function applyOptionIsMetaToAll(value: boolean): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.macOptionIsMeta = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Live theme swap — update all live terminals when the app theme changes
// ---------------------------------------------------------------------------

subscribeTheme((theme) => {
  repaintAllTerminals(theme)
})

// Live-apply terminal settings (cursor-blink toggle, scroll speed, Option-as-Meta)
// so changes are visible without a reload.
let lastFontFamily = getTerminalFontFamily()
let lastFontSize = getTerminalBaseFontSize()
let lastCursorBlink = getCursorBlink()
let lastScrollSensitivity = getScrollSensitivity()
let lastContrastRatio = getContrastRatio()
let lastOptionIsMeta = getOptionIsMeta()
useSettingsStore.subscribe((state) => {
  const fontFamily = resolveTerminalFontFamily(state.terminalFontFamily)
  const fontSize = resolveTerminalFontSize(state.terminalFontSize)
  if (fontFamily !== lastFontFamily || fontSize !== lastFontSize) {
    lastFontFamily = fontFamily
    lastFontSize = fontSize
    applyFontSettingsToAll(fontFamily, fontSize)
  }
  const cursorBlink = state.terminalCursorBlink === true
  if (cursorBlink !== lastCursorBlink) {
    lastCursorBlink = cursorBlink
    applyCursorBlinkToAll(cursorBlink && windowFocused)
  }
  const scrollSensitivity = clampScrollSensitivity(state.terminalScrollSpeed)
  if (scrollSensitivity !== lastScrollSensitivity) {
    lastScrollSensitivity = scrollSensitivity
    applyScrollSensitivityToAll(scrollSensitivity)
  }
  const contrastRatio = clampContrastRatio(state.terminalContrast)
  if (contrastRatio !== lastContrastRatio) {
    lastContrastRatio = contrastRatio
    applyContrastRatioToAll(contrastRatio)
  }
  const optionIsMeta = state.terminalOptionIsMeta !== false
  if (optionIsMeta !== lastOptionIsMeta) {
    lastOptionIsMeta = optionIsMeta
    applyOptionIsMetaToAll(optionIsMeta)
  }
})

// Pause cursor blinking while this window is not frontmost, resume on return.
if (typeof window !== 'undefined') {
  window.addEventListener('focus', () => {
    windowFocused = true
    applyCursorBlinkToAll(getCursorBlink())
  })
  window.addEventListener('blur', () => {
    windowFocused = false
    applyCursorBlinkToAll(false)
  })
}

// ---------------------------------------------------------------------------
// Device-pixel-ratio change — resync the shared glyph atlas across terminals
//
// DPR (the resolution the atlas is rasterized at) changes when the window moves
// to a monitor with a different scale factor. xterm handles this per terminal:
// its CoreBrowserService watches `matchMedia('screen and (resolution: Xdppx)')`
// and each terminal re-rasterizes its glyphs at the new DPR — reshaping the
// SHARED atlas but redrawing only itself, so every sibling is left with stale
// texture coordinates (scrambled glyphs) until something clears its model too.
//
// Mirror xterm's own resolution query so we fire on the same transitions, and
// schedule the coordinated resync on the next frame so it runs AFTER xterm's
// synchronous per-terminal handlers (and before the next paint). The query is
// DPR-specific, so re-register against the new ratio on every change.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  let dprRepaintRaf: number | null = null
  const watchDpr = (): void => {
    const mql = window.matchMedia(`screen and (resolution: ${window.devicePixelRatio}dppx)`)
    const onChange = (): void => {
      mql.removeEventListener('change', onChange)
      if (dprRepaintRaf !== null) cancelAnimationFrame(dprRepaintRaf)
      dprRepaintRaf = requestAnimationFrame(() => {
        dprRepaintRaf = null
        forceWebglRepaint()
      })
      watchDpr() // re-arm against the new device pixel ratio
    }
    mql.addEventListener('change', onChange)
  }
  watchDpr()
}
