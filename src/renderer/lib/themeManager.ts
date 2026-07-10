// =============================================================================
// themeManager — applies a unified Theme to the document.
//
// One Theme drives the whole IDE. applyTheme():
//   1. merges the theme's partial `app` map over BASE_DARK/BASE_LIGHT and writes
//      every CSS custom property as an inline style on <html> (an override layer
//      over the `:root` fallback in globals.css — works per-document, so each
//      detached window paints independently and any built-in OR imported theme
//      is supported without static CSS).
//   2. sets documentElement.dataset.theme = theme.type ('dark' | 'light') as a
//      hook for prefers-* style selectors (it no longer carries colors).
//   3. notifies subscribers with the full Theme object (terminals repaint, the
//      Monaco editor re-themes).
//   4. persists the theme id + an exact background to the boot snapshot so the
//      next cold launch constructs the BrowserWindow with the right color before
//      any JS runs (no white flash).
// =============================================================================

import type { Theme, ThemeSelection } from '../../shared/types'
import { useSettingsStore } from '../stores/settingsStore'
import {
  DEFAULT_DARK_THEME_ID,
  BUILT_IN_BY_ID,
} from '../../shared/themes'
import { mergeThemeApp, resolveTheme as resolveThemeSelection } from '../../shared/themeResolution'

let currentTheme: Theme = BUILT_IN_BY_ID[DEFAULT_DARK_THEME_ID]
let currentSelection: ThemeSelection = 'system'
const subscribers = new Set<(t: Theme) => void>()

let mediaQuery: MediaQueryList | null = null
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null

// ---------------------------------------------------------------------------
// Theme lookup
// ---------------------------------------------------------------------------

function prefersDark(): boolean {
  if (typeof window === 'undefined') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Resolve a selection ('system' or a theme id) to a concrete Theme. Unknown
 *  ids fall back to the matching default so a deleted/renamed theme never breaks. */
function resolveTheme(selection: ThemeSelection): Theme {
  // The OS preference only participates in the `system` selection. Avoid
  // eagerly touching matchMedia for an explicit theme (including non-browser
  // render/test environments where matchMedia does not exist).
  return resolveThemeSelection(
    useSettingsStore.getState(),
    selection,
    selection === 'system' ? prefersDark() : true,
  )
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function notify(theme: Theme): void {
  for (const cb of subscribers) cb(theme)
}

/** Compute the full merged app-var map for a theme. */
function injectAppVars(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const merged = mergeThemeApp(theme)
  for (const [key, value] of Object.entries(merged)) {
    root.style.setProperty('--' + key, value)
  }
  root.dataset.theme = theme.type
}

function attachMediaListener(): void {
  if (typeof window === 'undefined') return
  mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  mediaListener = () => {
    if (currentSelection !== 'system') return
    applyResolved(resolveTheme('system'))
  }
  mediaQuery.addEventListener('change', mediaListener)
}

function detachMediaListener(): void {
  if (mediaQuery && mediaListener) {
    mediaQuery.removeEventListener('change', mediaListener)
    mediaQuery = null
    mediaListener = null
  }
}

function applyResolved(theme: Theme): void {
  currentTheme = theme
  injectAppVars(theme)
  notify(theme)

  // Persist resolved theme id + exact background to the boot snapshot so the
  // next cold launch constructs the BrowserWindow with the right color, and
  // (on macOS) drive the native window appearance.
  try {
    const bg = theme.bootBackground ?? mergeThemeApp(theme)['surface-0']
    // macOS draws the native title bar itself when native tabs are on
    // (titleBarStyle 'default') — it can't take an arbitrary color, only a
    // dark/light system material. Send the desired appearance so the native bar
    // tracks the theme's dark/light (for built-in AND user-generated themes)
    // instead of blindly following the OS. While the selection is 'system' we
    // keep it on 'system' so `prefers-color-scheme` — and thus the system-theme
    // resolution above — stays bound to the real OS appearance.
    const appearance: 'dark' | 'light' | 'system' =
      currentSelection === 'system' ? 'system' : theme.type
    window.electronAPI?.bootSnapshotWrite({ theme: theme.id, backgroundColor: bg, appearance }).catch(() => { /* noop */ })
  } catch { /* noop */ }
}

/** Apply a theme selection ('system' or a theme id). */
export function applyTheme(selection: ThemeSelection): void {
  currentSelection = selection
  if (selection === 'system') {
    detachMediaListener()
    attachMediaListener()
  } else {
    detachMediaListener()
  }
  applyResolved(resolveTheme(selection))
}

export function getActiveTheme(): Theme {
  return currentTheme
}

/** Subscribe to the active Theme. Fires on every applyTheme/reapply. */
export function subscribeTheme(cb: (t: Theme) => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}
