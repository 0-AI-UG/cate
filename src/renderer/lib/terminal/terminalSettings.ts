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
 *  live terminal. xterm clears its contrast cache and does a full refresh on
 *  this option change, so already-rendered text is recoloured immediately. */
export function applyContrastRatioToAll(value: number): void {
  for (const entry of registry.values()) {
    try {
      entry.terminal.options.minimumContrastRatio = value
    } catch {
      /* terminal mid-dispose — ignore */
    }
  }
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
